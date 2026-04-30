<script setup>
import { onBeforeUnmount, onMounted, reactive, ref, watch, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Monitor, House, MapLocation, Warning, Setting,
  User, ArrowDown, Aim, DataLine, View, Calendar
} from '@element-plus/icons-vue'
import axios from 'axios'
import EsriMap from '@arcgis/core/Map'
import MapView from '@arcgis/core/views/MapView'
import GeoJSONLayer from '@arcgis/core/layers/GeoJSONLayer'
import * as echarts from 'echarts'

// ---------- 响应式变量 ----------
const activeMenu = ref('monitor')
const mapContainer = ref(null)
const trendChartRef = ref(null)
const selectedDate = ref('2025-08-01')

const layerControls = reactive({
  showFarming: true,
  showHeatwave: true
})

const currentFarmCenter = ref({ lat: 29.8, lon: 122.2 })
const trendDialogVisible = ref(false)

// ---------- 地图相关 ----------
let map = null
let view = null
let farmingLayer = null
let sstVisualLayer = null
let trendChart = null

// ---------- 海温图层 ----------
async function loadSSTHeatmap(date) {
  try {
    const { data } = await axios.get('http://localhost:3000/api/sst/all', { params: { date } })
    const docs = Array.isArray(data) ? data : []
    if (!docs.length) {
      if (sstVisualLayer) {
        map.remove(sstVisualLayer)
        sstVisualLayer = null
      }
      return
    }

    const sorted = docs.map(d => Number(d.anomaly)).filter(Number.isFinite).sort((a, b) => a - b)
    const n = sorted.length
    const minAnom = sorted[Math.floor(n * 0.05)]
    const maxAnom = sorted[Math.floor(n * 0.95)]

    if (sstVisualLayer) {
      map.remove(sstVisualLayer)
      sstVisualLayer = null
    }

    const features = docs.map(d => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
      properties: { anomaly: d.anomaly }
    }))
    const blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features })], { type: 'application/json' })
    const url = URL.createObjectURL(blob)

    sstVisualLayer = new GeoJSONLayer({
      url,
      title: `海温距平 (${date})`,
      outFields: ['anomaly'],
      popupTemplate: { title: '海温距平信息', content: '<b>距平值：</b> {anomaly} °C' },
      renderer: {
        type: 'simple',
        symbol: { type: 'simple-marker', style: 'square', size: '18px', outline: null },
        visualVariables: [{
          type: 'color',
          field: 'anomaly',
          stops: [
            { value: minAnom, color: [55, 95, 155, 0.7] },
            { value: (minAnom + maxAnom) / 2, color: [245, 245, 245, 0.08] },
            { value: maxAnom, color: [190, 35, 35, 0.75] }
          ]
        }]
      }
    })
    map.add(sstVisualLayer, 0)
    sstVisualLayer.visible = layerControls.showHeatwave
  } catch (err) {
    console.error('加载海温图层失败:', err)
  }
}

// ---------- 强制加载全部养殖区并自动缩放 ----------
async function loadAllFarmsForceZoom() {
  try {
    console.log('开始强制加载养殖区...')
    const res = await axios.get('http://localhost:3000/api/farms/in-view', {
      params: { xmin: -180, ymin: -90, xmax: 180, ymax: 90 } // 全范围
    })
    const geojson = res.data
    console.log('后端返回数据：', geojson)

    if (!geojson || !geojson.features || geojson.features.length === 0) {
      console.error('❌ 后端返回的养殖区数据为空！请检查数据库')
      ElMessage.error('养殖区数据为空，请检查MongoDB')
      return
    }

    // 移除旧图层
    if (farmingLayer) {
      map.remove(farmingLayer)
      farmingLayer = null
    }

    const blob = new Blob([JSON.stringify(geojson)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)

    farmingLayer = new GeoJSONLayer({
      url,
      title: '水产养殖区',
      outFields: ['*'],
      visible: layerControls.showFarming,
      popupTemplate: {
        title: '养殖区信息',
        content: 'ID: {ID}<br>类型: {Class}'
      },
      renderer: {
        type: 'simple',
        symbol: {
          type: 'simple-fill',
          color: [255, 0, 0, 0.8],
          outline: { color: [255, 255, 0, 1], width: 2 }
        }
      }
    })

    map.add(farmingLayer, 1)
    console.log('✅ 养殖区图层已添加，当前图层总数：', map.layers.length)

    // 图层加载完成后自动缩放到养殖区
    farmingLayer.when(() => {
      farmingLayer.queryExtent().then(ext => {
        if (ext) {
          console.log('📍 缩放至养殖区范围...')
          view.goTo(ext.expand(1.5), { duration: 1000 })
        } else {
          fallbackZoom(geojson)
        }
      }).catch(() => fallbackZoom(geojson))
    }, (err) => {
      console.error('养殖区图层加载失败:', err)
      fallbackZoom(geojson)
    })

    function fallbackZoom(geojson) {
      const coords = geojson.features[0].geometry.coordinates[0][0]
      console.log('📍 使用中心点缩放至', coords)
      view.goTo({ center: coords, zoom: 18 }, { duration: 1000 })
    }
  } catch (e) {
    console.error('❌ 强制加载养殖区失败：', e)
    ElMessage.error('养殖区加载失败，请检查后端服务')
  }
}

// ---------- 趋势图 ----------
async function renderTrendChart(center) {
  if (!trendChartRef.value) return
  try {
    // 自动取当前热力图选中的日期，如果未选则用今天
    const endDate = selectedDate.value || new Date().toISOString().slice(0, 10)

    console.log('请求趋势数据，中心:', center, '结束日期:', endDate)

    const { data } = await axios.get('http://localhost:3000/api/sst/timeseries', {
      params: {
        lat: center.lat,
        lon: center.lon,
        radius: 0.8,      // 已经足够覆盖多个网格点
        pastDays: 30,
        endDate: endDate
      }
    })

    console.log('趋势数据返回:', data)

    const rows = Array.isArray(data) ? data : []
    if (!rows.length) {
      ElMessage.warning('该养殖区暂无最近30天海温趋势数据（请确认所选日期附近有海温数据）')
      return
    }

    if (trendChart) trendChart.dispose()
    trendChart = echarts.init(trendChartRef.value)
    trendChart.setOption({
      title: { text: '养殖区海温距平趋势（过去30天）', left: 'center', textStyle: { fontSize: 14 } },
      tooltip: { trigger: 'axis' },
      grid: { left: 48, right: 20, top: 48, bottom: 35 },
      xAxis: { type: 'category', data: rows.map(d => d.date) },
      yAxis: { type: 'value', name: '距平(°C)' },
      series: [{
        type: 'line',
        data: rows.map(d => d.avgAnomaly),
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 2.5, color: '#1e88e5' },
        areaStyle: { color: 'rgba(30,136,229,0.12)' },
        markLine: {
          silent: true,
          data: [{ yAxis: 2.0, label: { formatter: '热浪阈值' }, lineStyle: { color: '#d32f2f', type: 'dashed' } }]
        }
      }]
    })
  } catch (e) {
    console.error(e)
    ElMessage.error('趋势图加载失败')
  }
}

watch(trendDialogVisible, async (visible) => {
  if (!visible) {
    if (trendChart) { trendChart.dispose(); trendChart = null }
    return
  }
  await nextTick()
  setTimeout(() => renderTrendChart(currentFarmCenter.value), 200)
})

// ---------- 地图交互 ----------
function bindMapClick() {
  view.on('click', async (event) => {
    const hitResult = await view.hitTest(event)

    const sstHit = hitResult.results.find(r => r.graphic?.layer === sstVisualLayer)
    if (sstHit) {
      const v = Number(sstHit.graphic.attributes?.anomaly)
      view.popup.open({
        location: event.mapPoint,
        title: '海温距平信息',
        content: `<b>距平值：</b> ${Number.isFinite(v) ? v.toFixed(3) : '--'} °C`
      })
      return
    }

    const farmHit = hitResult.results.find(r => r.graphic?.layer === farmingLayer)
    if (farmHit) {
      const g = farmHit.graphic
      if (g.geometry?.extent?.center) {
        currentFarmCenter.value = {
          lat: g.geometry.extent.center.latitude,
          lon: g.geometry.extent.center.longitude
        }
      }
      trendDialogVisible.value = true
      view.popup.close()
      return
    }

    view.popup.close()
  })
}

// ---------- 地图初始化 ----------
function initMap() {
  map = new EsriMap({ basemap: 'topo-vector' })
  view = new MapView({
    container: mapContainer.value,
    map,
    center: [122.1, 29.8],
    zoom: 9,
    highlightOptions: { color: [24, 144, 255, 1], haloOpacity: 0.6, fillOpacity: 0.2 }
  })
  view.ui.move('zoom', 'bottom-right')

  // 暴露到全局方便调试
  window.map = map
  window.view = view

  bindMapClick()
  loadSSTHeatmap(selectedDate.value)

  // 地图就绪后强制加载养殖区并聚焦
  view.when(() => {
    loadAllFarmsForceZoom()
  })
}

// ---------- 其他 ----------
function onDateChange(date) { loadSSTHeatmap(date) }
function resetView() { if (view) view.goTo({ center: [122.1, 29.8], zoom: 9 }) }

watch(() => layerControls.showFarming, (v) => { if (farmingLayer) farmingLayer.visible = v })
watch(() => layerControls.showHeatwave, (v) => { if (sstVisualLayer) sstVisualLayer.visible = v })

onMounted(initMap)
onBeforeUnmount(() => {
  if (trendChart) { trendChart.dispose(); trendChart = null }
  if (view) { view.destroy(); view = null }
  map = null
  farmingLayer = null
  sstVisualLayer = null
})
</script>

<template>
  <div class="app-container">
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

    <main class="workbench-layout">
      <aside class="left-control-panel">
        <div class="panel-section">
          <h3 class="section-title"><el-icon><DataLine /></el-icon> 宏观监测数据</h3>
          <div class="data-cards">
            <div class="data-card blue"><span class="card-label">已划定养殖区</span><span class="card-value">12 <small>个</small></span></div>
            <div class="data-card red"><span class="card-label">活跃热浪预警</span><span class="card-value">3 <small>起</small></span></div>
          </div>
        </div>
        <div class="panel-section">
          <h3 class="section-title"><el-icon><View /></el-icon> 图层显示控制</h3>
          <div class="layer-switch-list">
            <div class="switch-item"><span class="switch-label"><span class="color-box blue"></span> 水产养殖区</span><el-switch v-model="layerControls.showFarming" /></div>
            <div class="switch-item"><span class="switch-label"><span class="color-box red"></span> 海温距平图层</span><el-switch v-model="layerControls.showHeatwave" /></div>
          </div>
        </div>
        <div class="panel-section">
          <h3 class="section-title"><el-icon><Calendar /></el-icon> 海温数据日期</h3>
          <div class="date-picker-wrap">
            <el-date-picker v-model="selectedDate" type="date" placeholder="选择日期" format="YYYY-MM-DD" value-format="YYYY-MM-DD" @change="onDateChange" class="dark-date-picker" />
            <p class="date-hint">选择日期后自动加载该日海温距平热力图</p>
          </div>
        </div>
        <div class="panel-section flex-fill">
          <h3 class="section-title"><el-icon><Aim /></el-icon> 预警动态摘要</h3>
          <div class="news-list">
            <div class="news-item danger"><span class="time">10:30</span> 监测到舟山海域水温异常升高...</div>
            <div class="news-item warning"><span class="time">09:15</span> 台州1号网箱区即将进入波及范围...</div>
            <div class="news-item normal"><span class="time">08:00</span> 系统自动更新全球SST栅格数据。</div>
          </div>
        </div>
      </aside>

      <div class="map-wrapper">
        <div ref="mapContainer" class="map-view"></div>
        <div class="floating-toolbar">
          <el-tooltip content="复位视角" placement="left">
            <el-button circle @click="resetView"><el-icon><Aim /></el-icon></el-button>
          </el-tooltip>
        </div>
      </div>
    </main>

    <el-dialog v-model="trendDialogVisible" title="海温距平趋势分析" width="760px" class="trend-dialog" destroy-on-close>
      <div ref="trendChartRef" class="trend-chart"></div>
    </el-dialog>
  </div>
</template>

<style>
body { margin: 0; padding: 0; overflow: hidden; background-color: #f0f2f5; font-family: "Helvetica Neue", Helvetica, "PingFang SC", sans-serif; }
.esri-view-surface:focus::after { outline: none !important; }
</style>

<style scoped>
.app-container { width: 100vw; height: 100vh; display: flex; flex-direction: column; }
.top-header { height: 80px; background-image: linear-gradient(90deg, rgba(5, 25, 55, 0.75) 0%, rgba(0, 77, 122, 0.65) 100%), url('https://images.unsplash.com/photo-1518837695005-2083093ee35b?q=80&w=2070&auto=format&fit=crop'); background-size: cover; background-position: center; display: flex; align-items: center; justify-content: space-between; padding: 0 30px; box-shadow: 0 4px 12px rgba(0,0,0,.3); z-index: 10; }
.logo-area { display: flex; align-items: center; gap: 12px; width: 300px; }
.logo-icon { color: #00e5ff; }
.system-title { font-size: 20px; font-weight: 700; color: #fff; letter-spacing: 2px; white-space: nowrap; text-shadow: 0 2px 4px rgba(0,0,0,.5); }
.nav-menu-container { flex: 1; display: flex; justify-content: center; }
.top-menu { border-bottom: none !important; height: 80px; background-color: transparent !important; }
:deep(.el-menu-item), :deep(.el-sub-menu__title) { font-size: 16px !important; color: #e4e7ed !important; height: 80px !important; line-height: 80px !important; }
:deep(.el-menu-item.is-active) { color: #00e5ff !important; font-weight: 700; border-bottom: 4px solid #00e5ff !important; background-color: rgba(255,255,255,.05) !important; }
:deep(.el-menu-item:hover), :deep(.el-sub-menu__title:hover) { color: #fff !important; background-color: rgba(255,255,255,.1) !important; }
.user-area { width: 200px; display: flex; justify-content: flex-end; align-items: center; }
.user-dropdown-link { display: flex; align-items: center; cursor: pointer; gap: 10px; color: #fff; }
.user-avatar { background-color: rgba(0,229,255,.2); color: #00e5ff; border: 1px solid rgba(0,229,255,.5); }
.username { font-size: 15px; font-weight: 500; letter-spacing: 1px; }
.workbench-layout { flex: 1; display: flex; height: calc(100vh - 80px); background-image: linear-gradient(135deg, rgba(235,243,250,.10) 0%, rgba(215,230,245,.20) 100%), url('https://images.unsplash.com/photo-1498623116890-37e912163d5d?q=80&w=2070&auto=format&fit=crop'); background-size: cover; background-position: center; padding: 18px; gap: 18px; }
.left-control-panel { width: 320px; background: rgba(255,255,255,.35); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); border-radius: 12px; border: 1px solid rgba(255,255,255,.5); box-shadow: 0 8px 32px rgba(0,30,80,.08); display: flex; flex-direction: column; overflow-y: auto; }
.panel-section { padding: 18px 20px; border-bottom: 1px solid rgba(255,255,255,.4); }
.panel-section.flex-fill { flex: 1; border-bottom: none; }
.section-title { margin: 0 0 16px; font-size: 15px; font-weight: 700; color: #2c3e50; display: flex; align-items: center; gap: 6px; }
.section-title .el-icon { color: #1890ff; font-size: 18px; }
.data-cards { display: flex; gap: 12px; }
.data-card { flex: 1; padding: 14px 12px; border-radius: 8px; display: flex; flex-direction: column; justify-content: center; backdrop-filter: blur(4px); }
.data-card.blue { background-color: rgba(230,247,255,.6); border: 1px solid rgba(145,213,255,.5); }
.data-card.red { background-color: rgba(255,241,240,.6); border: 1px solid rgba(255,163,158,.5); }
.card-label { font-size: 12px; color: #5c6b77; margin-bottom: 4px; font-weight: 500; }
.card-value { font-size: 22px; font-weight: 700; }
.data-card.blue .card-value { color: #1890ff; }
.data-card.red .card-value { color: #f5222d; }
.card-value small { font-size: 12px; font-weight: normal; color: #8c9bad; }
.layer-switch-list { display: flex; flex-direction: column; gap: 12px; }
.switch-item { display: flex; justify-content: space-between; align-items: center; background-color: rgba(255,255,255,.4); padding: 10px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,.5); box-shadow: inset 0 0 10px rgba(255,255,255,.2); }
.switch-label { display: flex; align-items: center; font-size: 14px; color: #34495e; font-weight: 500; }
.color-box { width: 14px; height: 14px; margin-right: 10px; border-radius: 3px; }
.color-box.blue { background: rgba(24,144,255,.3); border: 1px dashed #1890ff; }
.color-box.red { background: rgba(245,34,45,.3); border: 1px solid rgba(245,34,45,.6); }
.date-picker-wrap { display: flex; flex-direction: column; gap: 8px; }
.dark-date-picker { width: 100%; }
.date-hint { font-size: 12px; color: #8499b0; margin: 0; line-height: 1.4; }
.news-list { display: flex; flex-direction: column; gap: 12px; }
.news-item { font-size: 13px; color: #4a5a6a; line-height: 1.6; position: relative; padding-left: 14px; }
.news-item::before { content: ''; position: absolute; left: 0; top: 7px; width: 6px; height: 6px; border-radius: 50%; }
.news-item.danger::before { background-color: #f5222d; box-shadow: 0 0 4px #f5222d; }
.news-item.warning::before { background-color: #faad14; box-shadow: 0 0 4px #faad14; }
.news-item.normal::before { background-color: #1890ff; box-shadow: 0 0 4px #1890ff; }
.news-item .time { color: #8c9bad; margin-right: 6px; font-family: monospace; font-weight: 700; }
.map-wrapper { flex: 1; position: relative; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 32px rgba(0,30,80,.1); border: 2px solid rgba(255,255,255,.7); }
.map-view { width: 100%; height: 100%; }
.floating-toolbar { position: absolute; top: 20px; right: 20px; display: flex; flex-direction: column; gap: 10px; z-index: 5; }
.trend-chart { width: 100%; height: 360px; }
:deep(.trend-dialog .el-dialog) { border-radius: 8px; }
</style>
