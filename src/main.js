import { createApp } from 'vue'
import './style.css'
import 'element-plus/dist/index.css'
import '@arcgis/core/assets/esri/themes/light/main.css'
import ElementPlus from 'element-plus'
import App from './App.vue'

createApp(App).use(ElementPlus).mount('#app')
