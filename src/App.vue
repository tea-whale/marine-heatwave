<script setup>
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { 
  Monitor, House, MapLocation, Warning, Setting, 
  User, ArrowDown, Aim, DataLine, View, Calendar
} from '@element-plus/icons-vue'
import axios from 'axios'
import EsriMap from '@arcgis/core/Map'
import MapView from '@arcgis/core/views/MapView'
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer'
import Graphic from '@arcgis/core/Graphic'
import Polygon from '@arcgis/core/geometry/Polygon'
import GeoJSONLayer from '@arcgis/core/layers/GeoJSONLayer'
import HeatmapRenderer from '@arcgis/core/renderers/HeatmapRenderer'
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol' // 导入点符号

const activeMenu = ref('monitor')
const drawerVisible = ref(false)
const mapContainer = ref(null)

// 日期选择器绑定的日期（默认2025年夏季某天）
const selectedDate = ref('2025-08-01')

// 左侧控制台状态
const layerControls = reactive({
  showFarming: true,
  showHeatwave: true // 用来控制我们新的真实热力图
})

const panelData = reactive({
  zoneName: '舟山高价值网箱养殖区',
  riskLevel: '高风险',
  impactArea: '142.5 平方公里',
  updateTime: '2023-10-27 14:00'
})

let map = null
let view = null
let farmingLayer = null
// let heatwaveGraphicsLayer = null; // <--- 1. 删掉这行，我们不需要假的图层了
let sstHeatmapLayer = null  // 后端驱动的热力图图层

// ==================== 加载海温距平热力图 ====================
// ==================== 加载海温距平热力图（最终版） ====================
// ==================== 加载全距平热力图 ====================
async function loadSSTHeatmap(date) {
  try {
    const response = await axios.get('http://localhost:3000/api/sst/all', {
      params: { date }
    })

    const docs = response.data
    if (!docs || docs.length === 0) {
      if (sstHeatmapLayer) {
        map.remove(sstHeatmapLayer)
        sstHeatmapLayer = null
      }
      return
    }

    // 1. 提取距平值并排序，用于计算分位数
    const anomalies = docs.map(d => d.anomaly).sort((a, b) => a - b)
    const n = anomalies.length

    // 2. 使用第 5 百分位作为下界，第 95 百分位作为上界（裁剪掉极端值，拉伸对比度）
    const lowerIdx = Math.floor(n * 0.05)
    const upperIdx = Math.floor(n * 0.95)
    const minAnom = anomalies[lowerIdx]
    const maxAnom = anomalies[upperIdx]

console.log(`[${date}] 距平范围(5%-95%): ${minAnom.toFixed(2)} ~ ${maxAnom.toFixed(2)}`)

// 移除旧图层
if (sstHeatmapLayer) {
  map.remove(sstHeatmapLayer)
  sstHeatmapLayer = null
}

// 转换为 GeoJSON (保持不变)
const features = docs.map(doc => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [doc.lon, doc.lat] },
  properties: { anomaly: doc.anomaly }
}))

const geojson = { type: 'FeatureCollection', features }
const blob = new Blob([JSON.stringify(geojson)], { type: 'application/json' })
const url = URL.createObjectURL(blob)

// 🚀 核心修改区：创建气象级的网格点渲染图层
sstHeatmapLayer = new GeoJSONLayer({
  url: url,
  title: `海温距平 (${date})`,
  
  // 使用 SimpleRenderer 配合视觉变量
  renderer: {
    type: "simple",
    symbol: {
      type: "simple-marker",
      // 如果你的数据是标准的方块网格，用 "square" 会拼成完美的像素风面状图
      // 如果网格间距比较大，用 "circle" 也可以
      style: "square", 
      size: "12px", // ⚠️ 根据你的网格密度调整这个大小，让点刚好无缝拼接起来
      outline: {
        width: 0 // 必须去掉边框，否则密集的点全是边框线
      }
    },
    // 🔥 核心：根据 anomaly 字段的值，动态赋予颜色
    visualVariables: [
      {
        type: "color",
        field: "anomaly",
        // 让颜色严格映射到对应的距平值上
        stops: [
          { value: minAnom, color: [0, 0, 139, 0.85] },      // 极冷：深蓝
          { value: minAnom / 2, color: [0, 180, 255, 0.7] }, // 偏冷：浅蓝
          { value: 0, color: [255, 255, 255, 0.1] },         // 正常无距平：设为近乎透明，露出海底地形！
          { value: maxAnom / 2, color: [255, 200, 0, 0.8] }, // 偏暖：橙黄
          { value: maxAnom, color: [220, 20, 20, 0.9] }      // 极热(热浪)：深红
        ]
      }
    ]
  }
})

map.add(sstHeatmapLayer)
    console.log(`[${date}] 已加载 ${features.length} 个格点`)
    
  } catch (err) {
    console.error('加载热力图失败:', err)
  }
}

// 日期切换事件
function onDateChange(date) {
  loadSSTHeatmap(date)
}

// ==================== 地图初始化 ====================
const initMap = () => {
  farmingLayer = new GraphicsLayer({ title: '养殖区图层', visible: layerControls.showFarming })

  map = new EsriMap({
    basemap: 'topo-vector',  // 国内直连稳定底图
    layers: [farmingLayer] // 3. 只添加养殖区图层，不要假的heatwaveGraphicsLayer了
  })

  view = new MapView({
    container: mapContainer.value,
    map,
    center: [122.1, 29.8],
    zoom: 9,
    highlightOptions: { color: [24, 144, 255, 1], haloOpacity: 0.6, fillOpacity: 0.2 }
  })

  view.ui.move("zoom", "bottom-right")

  // 蓝色养殖区
  const farmingPolygon = new Polygon({
    rings: [
      [121.8, 30.1], [122.1, 30.0], [122.3, 29.8], 
      [122.2, 29.6], [121.9, 29.6], [121.7, 29.8]
    ],
    spatialReference: { wkid: 4326 }
  })
  const farmingGraphic = new Graphic({
    geometry: farmingPolygon,
    attributes: { zoneName: '东海01号网箱集群', riskLevel: '极大风险', impactArea: '142.5 平方公里' },
    symbol: { type: 'simple-fill', color: [24, 144, 255, 0.25], outline: { color: [24, 144, 255, 0.9], width: 1.5, style: 'dash' } }
  })

  farmingLayer.add(farmingGraphic)

  view.on('click', async (event) => {
    const hitResult = await view.hitTest(event)
    const farmingHit = hitResult.results.find((item) => item.graphic.layer === farmingLayer)

    if (!farmingHit) {
      drawerVisible.value = false
      return
    }

    const clickedGraphic = farmingHit.graphic
    panelData.zoneName = clickedGraphic.attributes.zoneName
    panelData.riskLevel = clickedGraphic.attributes.riskLevel
    panelData.impactArea = clickedGraphic.attributes.impactArea
    drawerVisible.value = true
  })

  // 初始化加载默认日期的热力图
  loadSSTHeatmap(selectedDate.value)
}

// 监听图层开关 (只保留养殖区和真实热力图)
watch(() => layerControls.showFarming, (val) => { if (farmingLayer) farmingLayer.visible = val })
watch(() => layerControls.showHeatwave, (val) => { if (sstHeatmapLayer) sstHeatmapLayer.visible = val }) // 控制真实热力图

const handleExport = () => {
  ElMessage.success('报告导出请求已发送，请稍后在下载中心查看。')
}

const resetView = () => {
  if (view) view.goTo({ center: [122.1, 29.8], zoom: 9 })
}

onMounted(() => { initMap() })
onBeforeUnmount(() => {
  if (view) { view.destroy(); view = null }
  map = null; farmingLayer = null; sstHeatmapLayer = null // 不再需要heatwaveGraphicsLayer
})
</script>

<template>
  <div class="app-container">
    <!-- 顶部 Header -->
    <header class="top-header">
      <div class="logo-area">
        <el-icon class="logo-icon" :size="28"><Monitor /></el-icon>
        <span class="system-title">区域海洋热浪灾害预警平台</span>
      </div>

      <div class="nav-menu-container">
        <el-menu :default-active="activeMenu" class="top-menu" mode="horizontal" :ellipsis="false">
          <el-menu-item index="home"><el-icon><House /></el-icon>首页</el-menu-item>
          <el-menu-item index="monitor"><el-icon><MapLocation /></el-icon>热浪监测</el-menu-item>
          <el-sub-menu index="analysis">
            <template #title><el-icon><Warning /></el-icon>灾害分析</template>
            <el-menu-item index="analysis-1">养殖区空间叠置</el-menu-item>
            <el-menu-item index="analysis-2">历史溯源</el-menu-item>
          </el-sub-menu>
          <el-menu-item index="admin"><el-icon><Setting /></el-icon>系统管理</el-menu-item>
        </el-menu>
      </div>

      <div class="user-area">
        <el-dropdown trigger="click">
          <span class="user-dropdown-link">
            <el-avatar :size="32" :icon="User" class="user-avatar" />
            <span class="username">管理员</span>
            <el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item>个人中心</el-dropdown-item>
              <el-dropdown-item divided>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>

    <!-- 工作台主体区 -->
    <main class="workbench-layout">
      
      <!-- 左侧业务控制台 -->
      <aside class="left-control-panel">
        <div class="panel-section">
          <h3 class="section-title"><el-icon><DataLine /></el-icon> 宏观监测数据</h3>
          <div class="data-cards">
            <div class="data-card blue">
              <span class="card-label">已划定养殖区</span>
              <span class="card-value">12 <small>个</small></span>
            </div>
            <div class="data-card red">
              <span class="card-label">活跃热浪预警</span>
              <span class="card-value">3 <small>起</small></span>
            </div>
          </div>
        </div>

        <div class="panel-section">
          <h3 class="section-title"><el-icon><View /></el-icon> 图层显示控制</h3>
          <div class="layer-switch-list">
            <div class="switch-item">
              <span class="switch-label">
                <span class="color-box blue"></span> 重点网箱养殖区
              </span>
              <el-switch v-model="layerControls.showFarming" />
            </div>
            <div class="switch-item">
              <span class="switch-label">
                <span class="color-box red"></span> MHWs 海洋热浪
              </span>
              <el-switch v-model="layerControls.showHeatwave" />
            </div>
          </div>
        </div>

        <!-- 日期选择器区域 -->
        <div class="panel-section">
          <h3 class="section-title"><el-icon><Calendar /></el-icon> 海温数据日期</h3>
          <div class="date-picker-wrap">
            <el-date-picker
              v-model="selectedDate"
              type="date"
              placeholder="选择日期"
              format="YYYY-MM-DD"
              value-format="YYYY-MM-DD"
              @change="onDateChange"
              class="dark-date-picker"
            />
            <p class="date-hint">选择日期后自动加载该日海温距平热力图</p>
          </div>
        </div>

        <div class="panel-section flex-fill">
          <h3 class="section-title"><el-icon><Aim /></el-icon> 预警动态摘要</h3>
          <div class="news-list">
            <div class="news-item danger">
              <span class="time">10:30</span> 监测到舟山海域水温异常升高...
            </div>
            <div class="news-item warning">
              <span class="time">09:15</span> 台州1号网箱区即将进入波及范围...
            </div>
            <div class="news-item normal">
              <span class="time">08:00</span> 系统自动更新全球SST栅格数据。
            </div>
          </div>
        </div>
      </aside>

      <!-- 右侧大地图容器 -->
      <div class="map-wrapper">
        <div ref="mapContainer" class="map-view"></div>
        
        <div class="floating-toolbar">
          <el-button circle title="复位视角" @click="resetView">
            <el-icon><Aim /></el-icon>
          </el-button>
        </div>
      </div>
    </main>

    <!-- 右侧灾害抽屉 -->
    <el-drawer
      v-model="drawerVisible"
      append-to-body
      :modal="false"
      size="320px"
      title="灾害评估明细"
      class="clean-drawer"
    >
      <div class="drawer-body">
        <el-descriptions :column="1" border direction="vertical">
          <el-descriptions-item label="受灾主体名称">
            <strong>{{ panelData.zoneName }}</strong>
          </el-descriptions-item>
          <el-descriptions-item label="综合风险评估等级">
            <el-tag type="danger" effect="light" size="large">
              <el-icon><Warning /></el-icon> {{ panelData.riskLevel }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="相交波及预估面积">
            <span class="area-text">{{ panelData.impactArea }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="最新监测时间">
            {{ panelData.updateTime }}
          </el-descriptions-item>
        </el-descriptions>
        <div class="drawer-footer">
          <el-button type="primary" class="export-btn" @click="handleExport">导出叠加分析报告</el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style>
body { margin: 0; padding: 0; overflow: hidden; background-color: #f0f2f5; font-family: "Helvetica Neue", Helvetica, "PingFang SC", sans-serif; }
.esri-view-surface:focus::after { outline: none !important; }
</style>

<style scoped>
.app-container {
  width: 100vw; height: 100vh;
  display: flex; flex-direction: column;
}

.top-header {
  height: 80px;
  background-image: 
    linear-gradient(90deg, rgba(5, 25, 55, 0.75) 0%, rgba(0, 77, 122, 0.65) 100%),
    url('https://images.unsplash.com/photo-1518837695005-2083093ee35b?q=80&w=2070&auto=format&fit=crop');
  background-size: cover; background-position: center;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 30px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); z-index: 10;
}
.logo-area { display: flex; align-items: center; gap: 12px; width: 300px; }
.logo-icon { color: #00e5ff; }
.system-title { font-size: 20px; font-weight: bold; color: #ffffff; letter-spacing: 2px; white-space: nowrap; text-shadow: 0 2px 4px rgba(0,0,0,0.5); }
.nav-menu-container { flex: 1; display: flex; justify-content: center; }
.top-menu { border-bottom: none !important; height: 80px; background-color: transparent !important; }
:deep(.el-menu-item), :deep(.el-sub-menu__title) { font-size: 16px !important; color: #e4e7ed !important; height: 80px !important; line-height: 80px !important; }
:deep(.el-menu-item.is-active) { color: #00e5ff !important; font-weight: bold; border-bottom: 4px solid #00e5ff !important; background-color: rgba(255, 255, 255, 0.05) !important; }
:deep(.el-menu-item:hover), :deep(.el-sub-menu__title:hover) { color: #ffffff !important; background-color: rgba(255, 255, 255, 0.1) !important; }
.user-area { width: 200px; display: flex; justify-content: flex-end; align-items: center; }
.user-dropdown-link { display: flex; align-items: center; cursor: pointer; gap: 10px; color: #ffffff; }
.user-avatar { background-color: rgba(0, 229, 255, 0.2); color: #00e5ff; border: 1px solid rgba(0, 229, 255, 0.5); }
.username { font-size: 15px; font-weight: 500; letter-spacing: 1px; }

.workbench-layout {
  flex: 1;
  display: flex;
  height: calc(100vh - 80px);
  background-image: 
    linear-gradient(135deg, rgba(235, 243, 250, 0.10) 0%, rgba(215, 230, 245, 0.20) 100%),
    url('https://images.unsplash.com/photo-1498623116890-37e912163d5d?q=80&w=2070&auto=format&fit=crop');
  background-size: cover;
  background-position: center;
  padding: 18px; 
  gap: 18px;
}

.left-control-panel {
  width: 320px;
  background: rgba(255, 255, 255, 0.35);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  box-shadow: 0 8px 32px rgba(0, 30, 80, 0.08);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.panel-section {
  padding: 18px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.4);
}
.panel-section.flex-fill { flex: 1; border-bottom: none; }
.section-title {
  margin: 0 0 16px 0; font-size: 15px; font-weight: bold; color: #2c3e50;
  display: flex; align-items: center; gap: 6px;
}
.section-title .el-icon { color: #1890ff; font-size: 18px;}

.data-cards { display: flex; gap: 12px; }
.data-card {
  flex: 1; padding: 14px 12px; border-radius: 8px;
  display: flex; flex-direction: column; justify-content: center;
  backdrop-filter: blur(4px);
}
.data-card.blue { 
  background-color: rgba(230, 247, 255, 0.6); 
  border: 1px solid rgba(145, 213, 255, 0.5); 
}
.data-card.red { 
  background-color: rgba(255, 241, 240, 0.6); 
  border: 1px solid rgba(255, 163, 158, 0.5); 
}
.card-label { font-size: 12px; color: #5c6b77; margin-bottom: 4px; font-weight: 500;}
.card-value { font-size: 22px; font-weight: bold; }
.data-card.blue .card-value { color: #1890ff; }
.data-card.red .card-value { color: #f5222d; }
.card-value small { font-size: 12px; font-weight: normal; color: #8c9bad; }

.layer-switch-list { display: flex; flex-direction: column; gap: 12px; }
.switch-item {
  display: flex; justify-content: space-between; align-items: center;
  background-color: rgba(255, 255, 255, 0.4);
  padding: 10px 14px; border-radius: 8px; 
  border: 1px solid rgba(255, 255, 255, 0.5);
  box-shadow: inset 0 0 10px rgba(255,255,255,0.2);
}
.switch-label { display: flex; align-items: center; font-size: 14px; color: #34495e; font-weight: 500;}
.color-box { width: 14px; height: 14px; margin-right: 10px; border-radius: 3px; }
.color-box.blue { background: rgba(24, 144, 255, 0.3); border: 1px dashed #1890ff; }
.color-box.red { background: rgba(245, 34, 45, 0.3); border: 1px solid rgba(245, 34, 45, 0.6); }

/* 日期选择器 */
.date-picker-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dark-date-picker {
  width: 100%;
}
.date-hint {
  font-size: 12px;
  color: #8499b0;
  margin: 0;
  line-height: 1.4;
}

.news-list { display: flex; flex-direction: column; gap: 12px; }
.news-item { font-size: 13px; color: #4a5a6a; line-height: 1.6; position: relative; padding-left: 14px; }
.news-item::before { content: ''; position: absolute; left: 0; top: 7px; width: 6px; height: 6px; border-radius: 50%; }
.news-item.danger::before { background-color: #f5222d; box-shadow: 0 0 4px #f5222d; }
.news-item.warning::before { background-color: #faad14; box-shadow: 0 0 4px #faad14;}
.news-item.normal::before { background-color: #1890ff; box-shadow: 0 0 4px #1890ff;}
.news-item .time { color: #8c9bad; margin-right: 6px; font-family: monospace; font-weight: bold;}

.map-wrapper {
  flex: 1;
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 30, 80, 0.1);
  border: 2px solid rgba(255, 255, 255, 0.7);
}
.map-view { width: 100%; height: 100%; }

.floating-toolbar {
  position: absolute; top: 20px; right: 20px;
  display: flex; flex-direction: column; gap: 10px; z-index: 5;
}

:deep(.clean-drawer) { box-shadow: -4px 0 16px rgba(0,0,0,0.08); }
:deep(.el-drawer__header) { margin-bottom: 0; padding: 16px 20px; border-bottom: 1px solid #ebeef5; font-weight: bold; color: #303133; font-size: 16px; }
.drawer-body { padding: 20px; }
:deep(.el-descriptions__label) { background-color: #fafafa !important; color: #606266; font-weight: bold; }
:deep(.el-descriptions__content) { color: #303133; font-size: 14px; }
.area-text { font-size: 16px; font-weight: bold; color: #1890ff; }
.drawer-footer { margin-top: 24px; }
.export-btn { width: 100%; height: 40px; font-size: 15px; }
</style>