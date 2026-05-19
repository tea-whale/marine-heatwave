# 区域海洋热浪预警平台


基于 Vue 3 + ArcGIS Maps SDK for JavaScript + Node.js + MongoDB 的海洋热浪灾害监测与预警 WebGIS 平台。

主要功能
海温距平热力图：按日期查询全球海温距平数据，并以颜色渐变热力图展示。

养殖区管理：在地图上加载养殖区多边形，支持缩放定位与信息点击查询。

风险评估：基于缓冲区（0.05°）分析养殖区周围海温异常点，计算风险等级（高/中/低），导出 CSV 报告。

缓冲区分析：以养殖区为中心生成缓冲区，显示缓冲区内热浪点分布。

灾害分析：叠置分析与最近邻分析，识别受影响养殖区。

科学分析（研究员专用）：冷热点分析 (Getis-Ord Gi*)、等温线提取、热浪演变追踪。

角色权限：游客浏览，渔民查看风险评估，研究员全功能访问（含下载报告）。

系统管理：数据源统计上传、参数配置、底图切换（支持暗色地图）。

技术栈
前端	后端	数据库	地图
Vue 3, Element Plus, ECharts, Axios	Node.js, Express	MongoDB	ArcGIS Maps SDK for JavaScript
快速开始
环境要求
Node.js 18+

MongoDB 6.0+

Git

安装与运行
克隆项目并安装依赖

bash
git clone https://github.com/tea-whale/marine-heatwave.git
cd 仓库名
npm install          # 前端依赖
cd server
npm install          # 后端依赖
cd ..
启动 MongoDB（确保本地 MongoDB 服务已运行）

启动后端

bash
cd server
node index.cjs
启动前端（新终端）

bash
npm run dev
访问 http://localhost:5173

测试账户
身份	用户名	密码
游客	无需登录	-
渔民	fisher	fisher123
研究人员	research	research123
数据说明
由于海温数据和养殖区数据文件较大，未包含在代码仓库中。请通过以下方式准备数据：

创建 MongoDB 数据库 marine-heatwave

在 server/index.cjs 中确保集合名与导入数据一致

使用系统管理页面的“数据源管理”上传 CSV/JSON 格式的海温数据（字段：lat, lon, anomaly, date）

养殖区数据需预先导入 farms 或 aquaculture_zone 集合，格式为 GeoJSON FeatureCollection

数据格式示例：
```
json
// sst_ocean 集合文档
{
  "lat": 29.875,
  "lon": 122.125,
  "anomaly": 2.13,
  "date": "2025-08-01T00:00:00Z"
}

// farms 集合文档
{
  "type": "Feature",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[...]]]
  },
  "properties": {
    "ID": 1,
    "Class": "aquaculture"
  }
}
```
项目结构
```
text
├── src/
│   ├── components/          # Vue 组件（包括 MonitorPage, DecisionPage, 分析工具等）
│   ├── composables/         # 共享逻辑（如 useRole）
│   ├── router/              # 路由配置
│   └── api/                 # API 请求封装
├── server/
│   ├── index.cjs            # Express 主入口
│   ├── user.cjs             # 用户认证接口
│   ├── Analysis.cjs         # 空间分析接口
│   └── route.cjs            # 路径规划接口
└── public/
```
注意事项
首次运行可能因缺少底图资源导致地图背景加载失败（需联网或使用可访问 ArcGIS 底图服务的网络）。

用户密码存储于后端内存，重启后重置为默认密码。

数据上传后需重启后端以刷新统计信息。
