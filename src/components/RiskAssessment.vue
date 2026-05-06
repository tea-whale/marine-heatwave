<script setup>
import { ref, watch, onBeforeUnmount, nextTick, reactive, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, Download, Close, WarningFilled, CircleCheckFilled, QuestionFilled } from '@element-plus/icons-vue'
import axios from 'axios'
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer'
import Graphic from '@arcgis/core/Graphic'
import Point from '@arcgis/core/geometry/Point'
import Polygon from '@arcgis/core/geometry/Polygon'
import * as geometryEngine from '@arcgis/core/geometry/geometryEngine'

// ==================== Props ====================
const props = defineProps({
  map: { type: Object, default: null },
  view: { type: Object, default: null },
  date: { type: String, default: '2025-08-01' }
})

// ==================== 辅助函数 ====================
const getMap = () => props.map || window.map
const getView = () => props.view || window.view

const ANOMALY_THRESHOLD = 1.0  // 异常阈值
const API = 'http://localhost:3000'

// ==================== 响应式状态 ====================
const visible = ref(false)
const assessing = ref(false)
const hasResults = ref(false)
const currentDate = ref('')

// 风险等级色表
const RISK_COLORS = {
  high: { fill: [220, 38, 38, 0.65], outline: [220, 38, 38, 1], label: '高风险', class: 'risk-high' },
  medium: { fill: [245, 158, 11, 0.55], outline: [245, 158, 11, 1], label: '中风险', class: 'risk-medium' },
  low: { fill: [34, 197, 94, 0.45], outline: [34, 197, 94, 1], label: '低风险', class: 'risk-low' }
}

// 风险评估结果
const riskResults = ref([])

// 统计汇总
const summary = reactive({
  total: 0,
  high: 0,
  medium: 0,
  low: 0,
  highPercent: 0,
  globalHotPoints: 0
})

// ==================== 图层引用 ====================
let riskLayer = null

// ==================== 方法 ====================

/** 确保图层已初始化 */
function initLayer() {
  const map = getMap()
  if (!map) return
  if (!riskLayer) {
    riskLayer = new GraphicsLayer({ title: '风险等级评估', listMode: 'hide' })
    map.add(riskLayer, 5)
  }
}

/** 清除分析结果 */
function clearResults() {
  if (riskLayer) riskLayer.removeAll()
  riskResults.value = []
  hasResults.value = false
  summary.total = 0
  summary.high = 0
  summary.medium = 0
  summary.low = 0
  summary.highPercent = 0
  summary.globalHotPoints = 0
}

/** 将 GeoJSON 几何转换为 ArcGIS Polygon */
function geoJSONToArcGISPolygon(geojson) {
  if (!geojson) return null
  const type = geojson.type
  let allRings = []

  if (type === 'Polygon') {
    allRings = geojson.coordinates
  } else if (type === 'MultiPolygon') {
    allRings = geojson.coordinates.flat()
  } else {
    return null
  }

  return new Polygon({
    rings: allRings,
    spatialReference: { wkid: 4326 }
  })
}

/** 打开面板 */
function openPanel() {
  visible.value = true
  currentDate.value = props.date
  nextTick(() => initLayer())
  // 自动执行评估
  if (!hasResults.value && !assessing.value) {
    nextTick(() => runAssessment())
  }
}

/** 关闭面板 */
function closePanel() {
  visible.value = false
}

/** 判断风险等级 */
function determineRiskLevel(maxAnomaly, avgAnomaly, hotCount) {
  if (maxAnomaly >= 2.0 || (hotCount >= 3 && avgAnomaly >= 1.5)) {
    return 'high'
  } else if (maxAnomaly >= 1.0 || (hotCount >= 1 && avgAnomaly >= 0.8)) {
    return 'medium'
  } else {
    return 'low'
  }
}

/** 执行风险评估 */
async function runAssessment() {
  const view = getView()
  const map = getMap()
  if (!view || !map) {
    ElMessage.error('地图尚未初始化')
    return
  }

  assessing.value = true
  clearResults()
  initLayer()

  try {
    // ─── 1. 并行加载养殖区与海温距平数据 ───
    const [farmRes, sstRes] = await Promise.all([
      axios.get(`${API}/api/farms/in-view`, { params: { xmin: -180, ymin: -90, xmax: 180, ymax: 90 } }),
      axios.get(`${API}/api/sst/all`, { params: { date: currentDate.value } })
    ])

    const farms = farmRes.data?.features || []
    const sstDocs = Array.isArray(sstRes.data) ? sstRes.data : []

    if (farms.length === 0) {
      ElMessage.warning('未找到养殖区数据')
      assessing.value = false
      return
    }
    if (sstDocs.length === 0) {
      ElMessage.warning(`日期 ${currentDate.value} 没有海温数据`)
      assessing.value = false
      return
    }

    // ─── 2. 统计全局异常点 ───
    const globalHot = sstDocs.filter(d => {
      const a = Number(d?.anomaly)
      return Number.isFinite(a) && a > ANOMALY_THRESHOLD
    })
    summary.globalHotPoints = globalHot.length

    // ─── 3. 对每个养殖区评估风险 ───
    const results = []
    const allGraphics = []

    for (let i = 0; i < farms.length; i++) {
      const f = farms[i]
      const farmId = f.properties?.ID ?? `farm-${i}`
      const farmClass = f.properties?.Class ?? '未知'
      const farmGeom = geoJSONToArcGISPolygon(f.geometry)

      if (!farmGeom) {
        results.push({
          id: farmId,
          class: farmClass,
          maxAnomaly: null,
          avgAnomaly: null,
          hotCountInside: 0,
          riskLevel: 'unknown',
          riskLabel: '无法分析',
          anomalyRange: '--'
        })
        continue
      }

      // 用养殖区 extent 粗筛候选点（加 0.3° 容差）
      const ext = farmGeom.extent
      const pad = 0.3
      const candidates = sstDocs.filter(d =>
        d.lon >= ext.xmin - pad &&
        d.lon <= ext.xmax + pad &&
        d.lat >= ext.ymin - pad &&
        d.lat <= ext.ymax + pad
      )

      let insidePoints = []
      if (candidates.length > 0) {
        // 精确相交判断
        for (const d of candidates) {
          const pt = new Point({
            longitude: d.lon,
            latitude: d.lat,
            spatialReference: { wkid: 4326 }
          })
          if (geometryEngine.contains(farmGeom, pt)) {
            insidePoints.push(d)
          }
        }
      }

      // 计算统计量
      let maxAnomaly = -Infinity
      let sumAnomaly = 0
      let hotCount = 0

      for (const d of insidePoints) {
        const a = Number(d.anomaly)
        if (Number.isFinite(a)) {
          if (a > maxAnomaly) maxAnomaly = a
          sumAnomaly += a
          if (a > ANOMALY_THRESHOLD) hotCount++
        }
      }

      const avgAnomaly = insidePoints.length > 0 ? sumAnomaly / insidePoints.length : 0
      const finalMax = Number.isFinite(maxAnomaly) ? maxAnomaly : 0

      // 判断风险等级
      const riskLevel = determineRiskLevel(finalMax, avgAnomaly, hotCount)
      const riskInfo = RISK_COLORS[riskLevel]

      results.push({
        id: farmId,
        class: farmClass,
        maxAnomaly: Number(finalMax.toFixed(2)),
        avgAnomaly: Number(avgAnomaly.toFixed(2)),
        hotCountInside: hotCount,
        totalInside: insidePoints.length,
        riskLevel,
        riskLabel: riskInfo.label,
        anomalyRange: finalMax > 0 ? `${avgAnomaly.toFixed(2)} (最高 ${finalMax.toFixed(2)})` : '无数据'
      })

      // 绘制风险着色面
      const fillColor = riskInfo.fill
      const outlineColor = riskInfo.outline

      allGraphics.push(new Graphic({
        geometry: farmGeom,
        attributes: {
          farmId,
          farmClass,
          riskLevel,
          riskLabel: riskInfo.label,
          maxAnomaly: finalMax.toFixed(2),
          avgAnomaly: avgAnomaly.toFixed(2),
          hotCount
        },
        popupTemplate: {
          title: `养殖区 #${farmId}`,
          content: `
            <b>类型：</b>${farmClass}<br>
            <b>风险等级：</b><span style="color:${riskLevel === 'high' ? '#dc2626' : riskLevel === 'medium' ? '#f59e0b' : '#22c55e'};font-weight:700;">${riskInfo.label}</span><br>
            <b>最高距平：</b>${finalMax.toFixed(2)} °C<br>
            <b>平均距平：</b>${avgAnomaly.toFixed(2)} °C<br>
            <b>异常点数：</b>${hotCount} / ${insidePoints.length}<br>
          `
        },
        symbol: {
          type: 'simple-fill',
          color: fillColor,
          outline: { color: outlineColor, width: 2.5 }
        }
      }))
    }

    // ─── 4. 渲染到图层 ───
    if (riskLayer) riskLayer.removeAll()
    for (const g of allGraphics) {
      riskLayer.add(g)
    }

    // ─── 5. 汇总统计 ───
    riskResults.value = results
    summary.total = results.length
    summary.high = results.filter(r => r.riskLevel === 'high').length
    summary.medium = results.filter(r => r.riskLevel === 'medium').length
    summary.low = results.filter(r => r.riskLevel === 'low').length
    summary.highPercent = summary.total > 0 ? Math.round((summary.high / summary.total) * 100) : 0
    hasResults.value = true

    // ─── 6. 缩放至养殖区范围 ───
    // GraphicsLayer 没有 queryExtent 方法，手动计算所有图形的合并范围
    if (allGraphics.length > 0 && view) {
      let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity
      for (const g of allGraphics) {
        if (g.geometry?.extent) {
          const e = g.geometry.extent
          if (e.xmin < xmin) xmin = e.xmin
          if (e.ymin < ymin) ymin = e.ymin
          if (e.xmax > xmax) xmax = e.xmax
          if (e.ymax > ymax) ymax = e.ymax
        }
      }
      if (Number.isFinite(xmin)) {
        const mergedExtent = { xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } }
        view.goTo(mergedExtent, { duration: 800 }).catch(() => {})
      }
    }

  } catch (e) {
    console.error('风险评估失败:', e)
    ElMessage.error('评估失败：' + (e.message || '未知错误'))
  } finally {
    assessing.value = false
  }
}

/** 导出 CSV */
function exportCSV() {
  if (riskResults.value.length === 0) {
    ElMessage.warning('没有可导出的数据')
    return
  }

  // 构建 CSV 内容
  const headers = ['养殖区ID', '类型', '风险等级', '最高距平(°C)', '平均距平(°C)', '异常点数', '总网格点数', '距平范围']
  const rows = riskResults.value.map(r => [
    r.id,
    r.class,
    r.riskLabel,
    r.maxAnomaly ?? '',
    r.avgAnomaly ?? '',
    r.hotCountInside,
    r.totalInside,
    r.anomalyRange
  ])

  // BOM 确保 Excel 正确识别 UTF-8
  const BOM = '\uFEFF'
  const csvContent = [headers.join(','), ...rows.map(row => row.map(v => `"${v}"`).join(','))].join('\n')

  const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `养殖区风险评估_${currentDate.value}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)

  ElMessage.success('风险评估报告已导出')
}

// ==================== 暴露给父组件 ====================
defineExpose({ openPanel })

// ==================== 生命周期 ====================
watch(visible, (v) => {
  if (v) {
    currentDate.value = props.date
  }
})

onBeforeUnmount(() => {
  clearResults()
  const map = getMap()
  if (map && riskLayer) {
    map.remove(riskLayer)
    riskLayer = null
  }
})
</script>

<template>
  <!-- ========== 触发按钮（悬浮在地图右下角） ========== -->
  <div class="risk-trigger" v-if="!visible">
    <el-tooltip content="风险等级评估" placement="left">
      <el-button
        type="warning"
        circle
        size="large"
        @click="openPanel"
        class="trigger-btn"
      >
        <el-icon :size="20"><WarningFilled /></el-icon>
      </el-button>
    </el-tooltip>
  </div>

  <!-- ========== 分析面板（悬浮弹窗） ========== -->
  <div class="risk-panel-backdrop" v-if="visible" @click.self="closePanel">
    <div class="risk-panel">
      <!-- 面板标题栏 -->
      <div class="panel-header">
        <span class="panel-title">风险评估与报告导出</span>
        <el-button text circle size="small" @click="closePanel" class="close-btn">
          <el-icon :size="16"><Close /></el-icon>
        </el-button>
      </div>

      <!-- 面板内容 -->
      <div class="panel-body">
        <!-- 日期信息 -->
        <div class="field">
          <label class="field-label">评估日期</label>
          <div class="date-display">{{ currentDate }}</div>
        </div>

        <!-- 操作按钮 -->
        <div class="field actions">
          <el-button
            type="warning"
            :loading="assessing"
            @click="runAssessment"
            :icon="Search"
          >
            {{ assessing ? '评估中...' : '开始评估' }}
          </el-button>
          <el-button
            :disabled="!hasResults"
            @click="exportCSV"
            :icon="Download"
            type="success"
          >
            导出 CSV 报告
          </el-button>
        </div>

        <!-- 结果统计 -->
        <div v-if="hasResults" class="result-section">
          <div class="stat-divider"></div>

          <!-- 汇总卡片 -->
          <div class="summary-cards">
            <div class="summary-card risk-high">
              <span class="card-num">{{ summary.high }}</span>
              <span class="card-label">高风险</span>
            </div>
            <div class="summary-card risk-medium">
              <span class="card-num">{{ summary.medium }}</span>
              <span class="card-label">中风险</span>
            </div>
            <div class="summary-card risk-low">
              <span class="card-num">{{ summary.low }}</span>
              <span class="card-label">低风险</span>
            </div>
          </div>

          <div class="global-info">
            共 {{ summary.total }} 个养殖区 · 高风险占比 {{ summary.highPercent }}% · 全球异常点 {{ summary.globalHotPoints }} 个
          </div>

          <!-- 风险列表表格 -->
          <div class="risk-table-wrap">
            <table class="risk-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>类型</th>
                  <th>风险等级</th>
                  <th>最高距平</th>
                  <th>异常点</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="r in riskResults"
                  :key="r.id"
                  :class="'row-' + r.riskLevel"
                >
                  <td>{{ r.id }}</td>
                  <td>{{ r.class }}</td>
                  <td>
                    <span :class="['risk-badge', r.riskLevel]">{{ r.riskLabel }}</span>
                  </td>
                  <td>{{ r.maxAnomaly !== null ? r.maxAnomaly + ' °C' : '--' }}</td>
                  <td>{{ r.hotCountInside }}/{{ r.totalInside }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 图例 -->
        <div v-if="hasResults" class="legend-hint">
          <span class="legend-title">图例：</span>
          <div class="legend-item">
            <span class="legend-swatch" style="background:rgba(220,38,38,0.65);border:2px solid #dc2626;"></span>
            <span>高风险（距平 >= 2°C 或多点异常 >= 1.5°C）</span>
          </div>
          <div class="legend-item">
            <span class="legend-swatch" style="background:rgba(245,158,11,0.55);border:2px solid #f59e0b;"></span>
            <span>中风险（距平 1~2°C）</span>
          </div>
          <div class="legend-item">
            <span class="legend-swatch" style="background:rgba(34,197,94,0.45);border:2px solid #22c55e;"></span>
            <span>低风险（距平 < 1°C）</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 触发按钮 ===== */
.risk-trigger {
  position: fixed;
  bottom: 204px;
  right: 32px;
  z-index: 1000;
}

.trigger-btn {
  width: 48px;
  height: 48px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  background: linear-gradient(135deg, #f59e0b, #d97706) !important;
  border: none !important;
}

.trigger-btn:hover {
  transform: scale(1.08);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
}

/* ===== 面板遮罩 ===== */
.risk-panel-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 50px 32px 0 0;
  pointer-events: none;
}

.risk-panel {
  pointer-events: all;
  width: 420px;
  max-height: calc(100vh - 100px);
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 12px 40px rgba(0, 20, 60, 0.18);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

/* ===== 标题栏 ===== */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  background: linear-gradient(135deg, #fff7ed, #ffedd5);
  border-radius: 12px 12px 0 0;
}

.panel-title {
  font-size: 16px;
  font-weight: 700;
  color: #9a3412;
  letter-spacing: 0.5px;
}

.close-btn {
  color: #78716c;
}

.close-btn:hover {
  color: #d32f2f;
  background: rgba(211, 47, 47, 0.08);
}

/* ===== 内容区 ===== */
.panel-body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 13px;
  font-weight: 600;
  color: #37474f;
}

.date-display {
  font-size: 14px;
  color: #d97706;
  font-weight: 600;
  background: #fff7ed;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid #fed7aa;
}

.actions {
  flex-direction: row;
  gap: 10px;
}

/* ===== 结果区 ===== */
.stat-divider {
  height: 1px;
  background: rgba(0, 0, 0, 0.08);
}

.summary-cards {
  display: flex;
  gap: 10px;
}

.summary-card {
  flex: 1;
  padding: 12px 8px;
  border-radius: 8px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.summary-card.risk-high {
  background: rgba(254, 226, 226, 0.8);
  border: 1px solid #fca5a5;
}

.summary-card.risk-medium {
  background: rgba(254, 243, 199, 0.8);
  border: 1px solid #fcd34d;
}

.summary-card.risk-low {
  background: rgba(220, 252, 231, 0.8);
  border: 1px solid #86efac;
}

.card-num {
  font-size: 26px;
  font-weight: 800;
}

.summary-card.risk-high .card-num { color: #dc2626; }
.summary-card.risk-medium .card-num { color: #d97706; }
.summary-card.risk-low .card-num { color: #16a34a; }

.card-label {
  font-size: 11px;
  color: #6b7280;
  font-weight: 600;
}

.global-info {
  font-size: 12px;
  color: #9ca3af;
  text-align: center;
}

/* ===== 表格 ===== */
.risk-table-wrap {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 6px;
}

.risk-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.risk-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
}

.risk-table th {
  background: #f8fafc;
  border-bottom: 2px solid #e2e8f0;
  padding: 8px 6px;
  color: #475569;
  font-weight: 700;
  font-size: 11px;
  text-align: left;
  white-space: nowrap;
}

.risk-table td {
  padding: 7px 6px;
  border-bottom: 1px solid #f1f5f9;
  color: #334155;
}

.row-high { background: rgba(254, 226, 226, 0.25); }
.row-medium { background: rgba(254, 243, 199, 0.2); }
.row-low { background: rgba(220, 252, 231, 0.15); }

.risk-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 700;
}

.risk-badge.high {
  background: #fee2e2;
  color: #dc2626;
}

.risk-badge.medium {
  background: #fef3c7;
  color: #d97706;
}

.risk-badge.low {
  background: #dcfce7;
  color: #16a34a;
}

/* ===== 图例 ===== */
.legend-hint {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 0 0;
}

.legend-title {
  font-size: 12px;
  font-weight: 700;
  color: #475569;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #64748b;
}

.legend-swatch {
  width: 18px;
  height: 14px;
  flex-shrink: 0;
  border-radius: 3px;
}
</style>
