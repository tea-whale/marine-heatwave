const express = require('express')
const cors = require('cors')
const { MongoClient } = require('mongodb')

const app = express()
const PORT = 3000

app.use(cors())
app.use(express.json())

const client = new MongoClient('mongodb://localhost:27017')
let db

async function connectDB() {
  await client.connect()
  db = client.db('marine-heatwave')
  console.log('MongoDB 已连接')
}

// 1) 查询某一天所有栅格点（用于地图）
app.get('/api/sst/all', async (req, res) => {
  try {
    const { date } = req.query
    if (!date) return res.status(400).json({ error: '缺少日期参数' })

    const dayStart = new Date(`${date}T00:00:00.000Z`)
    const dayEnd = new Date(`${date}T23:59:59.999Z`)

    const docs = await db.collection('sst_ocean')
      .find({ date: { $gte: dayStart, $lte: dayEnd } })
      .project({ lat: 1, lon: 1, anomaly: 1, _id: 0 })
      .toArray()

    res.json(docs)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: '查询失败' })
  }
})
app.get('/api/farms/debug', async (req, res) => {
  try {
    const count = await db.collection('farms').countDocuments()
    const sample = await db.collection('farms').findOne()
    res.json({ count, sample })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
app.get('/api/farms/in-view', async (req, res) => {
  try {
    const docs = await db.collection('farms').find({}).toArray()
    res.json({
      type: 'FeatureCollection',
      features: docs.map(d => ({
        type: 'Feature',
        geometry: d.geometry,
        properties: { ID: d.ID, Class: d.Class }
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 2) 查询某点周围 pastDays 天日均距平（用于趋势图）
// 替换原来的 /api/sst/timeseries
// 趋势数据接口（完全独立，不引用任何未定义变量）
app.get('/api/sst/timeseries', async (req, res) => {
  try {
    const { lat, lon, radius = 0.8, pastDays = 30, endDate } = req.query

    // 参数检查
    if (lat == null || lon == null) {
      return res.status(400).json({ error: '缺少经纬度参数' })
    }

    const latNum = Number(lat)
    const lonNum = Number(lon)
    const radiusNum = Number(radius)
    const daysNum = Number(pastDays)

    if (![latNum, lonNum, radiusNum, daysNum].every(n => Number.isFinite(n) && n > 0)) {
      return res.status(400).json({ error: '参数格式错误，必须为有效数字' })
    }

    // 处理 endDate：必须为 YYYY-MM-DD 格式，否则回退到今天
    let endDateObj
    if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      endDateObj = new Date(endDate + 'T00:00:00Z')
      if (isNaN(endDateObj.getTime())) {
        endDateObj = new Date()
      }
    } else {
      endDateObj = new Date()
    }
    endDateObj.setUTCHours(0, 0, 0, 0) // 强制到当天00:00 UTC

    const startDateObj = new Date(endDateObj.getTime() - daysNum * 24 * 60 * 60 * 1000)

    console.log('Timeseries 查询参数:', {
      latNum, lonNum, radiusNum, startDate: startDateObj.toISOString(), endDate: endDateObj.toISOString()
    })

    const docs = await db.collection('sst_ocean')
      .find({
        date: { $gte: startDateObj, $lte: endDateObj },
        lat: { $gte: latNum - radiusNum, $lte: latNum + radiusNum },
        lon: { $gte: lonNum - radiusNum, $lte: lonNum + radiusNum }
      })
      .project({ date: 1, anomaly: 1, _id: 0 })
      .toArray()

    // 聚合日均距平
    const dailyMap = {}
    docs.forEach(d => {
      if (!d?.date || !Number.isFinite(d?.anomaly)) return
      const day = new Date(d.date).toISOString().slice(0, 10)
      if (!dailyMap[day]) dailyMap[day] = { sum: 0, count: 0 }
      dailyMap[day].sum += d.anomaly
      dailyMap[day].count += 1
    })

    const result = Object.entries(dailyMap)
      .map(([day, v]) => ({
        date: day,
        avgAnomaly: Number((v.sum / v.count).toFixed(3))
      }))
      .sort((a, b) => a.date.localeCompare(b.date))

    res.json(result)
  } catch (e) {
    console.error('趋势数据接口错误:', e)
    res.status(500).json({ error: '服务器内部错误' })
  }
})

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`后端已启动: http://localhost:${PORT}`)
  })
})
