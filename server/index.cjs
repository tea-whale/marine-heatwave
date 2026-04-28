const express = require('express')
const cors = require('cors')
const { MongoClient } = require('mongodb')

const app = express()
const PORT = 3000

app.use(cors())
app.use(express.json())

// MongoDB 连接
const client = new MongoClient('mongodb://localhost:27017')
let db

async function connectDB() {
  await client.connect()
  db = client.db('marine-heatwave')
  console.log('MongoDB 已连接')
}

// ==================== 接口 ====================

// 1. 查询某一天的热浪格点
// 查询某一天所有格点的海温距平（无阈值限制）
app.get('/api/sst/all', async (req, res) => {
  const { date } = req.query
  if (!date) return res.status(400).json({ error: '缺少日期参数' })

  const docs = await db.collection('sst_anomalies')
    .find({ date: new Date(date) })
    .project({ lat: 1, lon: 1, anomaly: 1, _id: 0 })
    .toArray()

  res.json(docs)
})

// 2. 查询某一天某养殖区附近的海温数据（用于 ECharts 折线图）
app.get('/api/sst/timeseries', async (req, res) => {
  const { lat, lon, days = 30 } = req.query
  if (!lat || !lon) return res.status(400).json({ error: '缺少经纬度参数' })

  const docs = await db.collection('sst_anomalies')
    .find({
      lat: { $gte: parseFloat(lat) - 0.2, $lte: parseFloat(lat) + 0.2 },
      lon: { $gte: parseFloat(lon) - 0.2, $lte: parseFloat(lon) + 0.2 }
    })
    .sort({ date: -1 })
    .limit(parseInt(days))
    .project({ date: 1, anomaly: 1, _id: 0 })
    .toArray()

  res.json(docs)
})

// ==================== 启动 ====================
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`后端已启动：http://localhost:${PORT}`)
  })
})