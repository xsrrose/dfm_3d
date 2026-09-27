# 三角洲行动 · 3D 地图模型（HM 雷达「3D建模」导出）

从 `HM雷达` 页面「3D建模」功能提取的 6 张烽火地带地图的完整 3D 模型，
已转换为单文件 glTF 2.0（`.glb`，几何 + 材质 + 贴图全部内嵌）。

---

## 一、模型清单

| 地图 | slug | 三角面 | 顶点 | 区域数 | 材质 | 贴图 | 文件大小 |
|---|---|---:|---:|---:|---:|---:|---:|
| 核电站 | `az3` | 7,306,228 | 10,602,470 | 311 | 27 | 61 | 455.3 MB |
| 长弓溪谷 | `cgxg` | 6,838,296 | 9,861,489 | 433 | 44 | 68 | 444.5 MB |
| 潮汐监狱 | `cxjy` | 6,595,170 | 7,316,026 | 177 | 24 | 37 | 351.5 MB |
| 零号大坝 | `db` | 5,297,685 | 7,417,118 | 237 | 25 | 34 | 324.2 MB |
| 巴克什 | `bks` | 3,993,804 | 6,344,683 | 132 | 25 | 42 | 288.9 MB |
| 航天基地 | `htjd` | 3,151,342 | 4,873,972 | 135 | 23 | 40 | 211.5 MB |
| 航天基地（概览） | `htjd` | 271,893 | 476,397 | 1 | 15 | 25 | 25.4 MB |
| **合计** | | **33,454,418** | **46,892,155** | **1,426** | | **307** | **≈2.10 GB** |

> 每张地图的三角面总数与站点清单 `statistics` 声明**逐图精确吻合**。

### 精细度说明

manifest 同时声明 `high` 与 `mobile` 两档几何，但**服务器只部署了 `mobile`**：

```
GET .../huya-stream-models/htjd/region-0-mobile.64cbb73ff8cb9418.hsp  → 200  1155907 B
GET .../huya-stream-models/htjd/region-0-high.513cf6ecb19c5bd6.hsp    → 404  0 B
```

`high` 仅为清单声明，文件未部署。**`mobile` 即可获取的最高精度**
（源模型的 35% 简化，世界尺度误差 ≤ 0.1 m）。

「概览」档是源模型的 2% 简化，用于远景，近看会明显发糊。

---

## 二、坐标系

| 项 | 值 |
|---|---|
| 单位 | 参考世界**米** |
| 手性 | 源渲染器同款，**所有变换已烘焙** |
| 轴向 | 与 three.js/glTF 一致（Y 轴向上） |

各图包围盒（米）：

| 地图 | min (x, y, z) | max (x, y, z) | 半径 |
|---|---|---|---:|
| az3 | (-843.72, -77.79, -885.44) | (899.06, 204.81, 904.73) | 1257.2 |
| cgxg | (-2013.13, -61.71, -1002.64) | (464.79, 165.06, 1233.42) | 1672.7 |
| cxjy | (-410.83, -143.56, -411.28) | (454.73, 110.69, 424.41) | 614.9 |
| db | (-1001.17, -331.40, -839.90) | (1064.30, 266.13, 1225.54) | 1490.7 |
| bks | (-874.36, -1122.97, -842.73) | (988.97, 512.28, 640.00) | 1444.3 |
| htjd | (-694.90, -59.48, -694.90) | (694.90, 224.41, 746.17) | 1011.0 |

导入 Blender 若需 Y-up，绕 X 轴旋转 **-90°**（数据本身已按 Y-up 导出）。

> ⚠️ **长弓溪谷已做 Z 轴镜像**。源数据是镜像书写的，运行时靠
> `object3d.scale.z = -1` 翻回来，本仓库的导出已把该变换烘焙进几何
> （位置/法线 Z 取反 + 三角形绕序反转）。其余 5 张图无需镜像。

---

## 三、技术要点

### 1. 容器格式 `.hsp`（`huya-stream-pack-1`）

```
偏移 0   uint32 LE  0x31505348  magic "HSP1"
偏移 4   uint32 LE  headerLength
偏移 8   bytes      JSON 头（schema / stride=40 / parts[]）
偏移 8+len          meshoptimizer 压缩的顶点块与索引块
```

顶点为 **40 字节交错布局**：

| 字节 | 类型 | 语义 |
|---|---|---|
| 0..11 | `f32[3]` | position（参考世界米） |
| 12..23 | `i16[3]` | normal（÷32767） |
| 24..25 | `u8[2]` | tangent.xy |
| 26..29 | `u8[4]` | 顶点色 RGB + **A = 图集 tile 编号** |
| 30..31 | `u16` | region id |
| 32..39 | `f32[2]` | uv（tile 内部坐标） |

**解码自证**：解出的顶点缓冲重算 SHA-256，与包头 `vertexSha256` 逐字节一致。

### 2. 图集贴图必须烘焙 UV

大部分材质使用 **图集纹理**：原始 UV 只描述 tile 内部坐标，决定"用哪一块"的
tile 编号藏在**顶点色 alpha** 里，由着色器运行时重映射。直接导出原始 UV
会得到**花屏乱码**（每个三角形横跨整张图集）。

导出时已在 CPU 端 1:1 复刻 `huyaTextureUv()` 的图集分支并烘焙进 UV。
验证：**7/7 图集材质 100% 三角形 tile 编号恒定**，0 个跨 tile。

同时修正：`alphaMode` 不得全局设 MASK（图集 alpha 是 tile/AO 数据而非覆盖度，
会导致大面积 discard、整图渲染为黑）。

### 3. 法线贴图必须解码

游戏的法线纹理**不是标准切线空间法线图**，按材质族分别解码：

| 材质族 | 解码方式 |
|---|---|
| `nrmac-atlas` / `opacity-atlas` / `emission-atlas` | `huyaOctahedralNormal(rg)` —— **八面体编码** |
| `nrmac` / `opacity` / `emission-cpd` | `huyaRgNormal(rg)` |
| `cloth` / `plants` / `road-atlas` / `world-grid` | `vec2(r*a, g)*2-1`，**用到 alpha** |
| `decal` / `base-pbr` | 二次解包 |

直接当标准法线图使用 → 法线全错 → 表现为**建筑发黑发闷**、
**地面满屏"沙沙"噪点**。已在导出时按族精确解码为标准切线空间法线图
（实测单位长度 `lenMean = 1.000`）。

### 4. 纹理采样策略

源站着色器自行控制 LOD（非图集材质恒定 `lod = 0.0`，从不模糊）。
glTF 查看器让 GPU 自由选 mip，缺各向异性过滤时会在斜视地面过度模糊并闪烁。
建议查看时开启 **各向异性过滤 16×** 并保留 mipmap。

### 5. 水面

源站水面使用自研 `DepthWater` 着色器，**材质库中没有任何贴图**，glTF 无法表达。
导出时替代为：半透明（`BLEND`，alpha 0.62）+ 中低粗糙度反射 +
程序生成的**无缝可平铺波纹法线图**（按世界尺度平铺，每块约 220 m）。

> 局限：原着色器的按水深变色、菲涅尔、焦散无法用 PBR 表达；
> 平坦大平面上的太阳高光仍会聚成一条亮带。

---

## 四、下载模型

模型体积超过 GitHub 单文件 100 MB 限制，因此放在 **Release** 里（每个都能单独下载）：

**➡️ [Releases · models-v1](https://github.com/xsrrose/dfm_3d/releases/tag/models-v1)**

| 地图 | 文件 | 三角面 | 大小 | 直链 |
|---|---|---:|---:|---|
| 核电站 | `az3-full.glb` | 7,306,228 | 455.3 MB | [下载](https://github.com/xsrrose/dfm_3d/releases/download/models-v1/az3-full.glb) |
| 长弓溪谷 | `cgxg-full.glb` | 6,838,296 | 444.5 MB | [下载](https://github.com/xsrrose/dfm_3d/releases/download/models-v1/cgxg-full.glb) |
| 潮汐监狱 | `cxjy-full.glb` | 6,595,170 | 351.5 MB | [下载](https://github.com/xsrrose/dfm_3d/releases/download/models-v1/cxjy-full.glb) |
| 零号大坝 | `db-full.glb` | 5,297,685 | 324.2 MB | [下载](https://github.com/xsrrose/dfm_3d/releases/download/models-v1/db-full.glb) |
| 巴克什 | `bks-full.glb` | 3,993,804 | 288.9 MB | [下载](https://github.com/xsrrose/dfm_3d/releases/download/models-v1/bks-full.glb) |
| 航天基地 | `htjd-full.glb` | 3,151,342 | 211.5 MB | [下载](https://github.com/xsrrose/dfm_3d/releases/download/models-v1/htjd-full.glb) |
| 航天基地（概览） | `htjd-overview.glb` | 271,893 | 25.4 MB | [下载](https://github.com/xsrrose/dfm_3d/releases/download/models-v1/htjd-overview.glb) |

或一次性全部拉到本地：

```bash
node tools/fetch-models.mjs
```

### 打开方式

`.glb` 可直接拖入 **Blender / Unreal / Unity / Windows 3D 查看器**，
贴图已内嵌，无需任何外部文件。

- Blender：`File → Import → glTF 2.0`
- Unreal：`Import` → 选 `.glb`
- 命令行预览：`npx @gltf-transform/cli inspect <file>.glb`

---

## 五、本地端查看器

仓库自带一个零依赖的浏览器查看器（three.js 已本地化，不需要联网装包）。

```bash
# 1) 先把模型拉到本地（只需一次，约 2.1 GB）
node tools/fetch-models.mjs

# 2) 启动服务（必须走 HTTP，file:// 打不开 ES module）
python tools/serve-viewer.py 8899

# 3) 浏览器打开
#    http://127.0.0.1:8899/viewer/index.html
```

> **为什么必须先下载？** GitHub Release 资源不返回
> `Access-Control-Allow-Origin` 头，浏览器**无法跨域直连**。
> `tools/fetch-models.mjs` 走 Node（不受 CORS 限制），下载后由本地服务提供，
> 这样也顺带获得了离线能力与更快的加载速度。

### 两种模式

```bash
node tools/make-viewer-manifest.mjs            # 本地模式（默认，走 viewer/models/）
node tools/make-viewer-manifest.mjs --remote   # 在线模式（直链 Release，浏览器会被 CORS 拦）
```

### 功能

| 功能 | 说明 |
|---|---|
| 相机 | 环绕 / 飞行（`WASD` + 鼠标）/ 俯视 |
| 地图切换 | 6 张地图，全图 / 概览 |
| 对象显隐 | 逐个子网格开关（最多 2455 个） |
| 显示 | 线框、坐标轴、地面网格、地图边界盒、Y-up 旋转 |
| 环境 | 4 套预设（晴空/黄昏/阴天/夜间）+ 曝光、环境光、雾、点光 |
| 纹理 | 平滑 / 源站一致 / 锐利（各向异性 16×，治斜视模糊与闪烁） |
| 统计 | 实时三角面、对象数、显存估算、FPS |
| 深链 | `?map=az3&variant=full` 直接定位 |

### 目录结构

```
.
├─ README.md
├─ models.json                  模型清单（机读，含全部统计）
├─ viewer/
│  ├─ index.html  app.js  style.css
│  ├─ maps.json                 模型地址表（本地/在线两种模式）
│  ├─ models/                   模型放这里（运行 fetch-models.mjs 后出现）
│  └─ vendor/                   three.js r169 + GLTFLoader + OrbitControls + meshopt
└─ tools/
   ├─ serve-viewer.py           本地静态服务
   ├─ fetch-models.mjs          从 Release 批量下载模型
   └─ make-viewer-manifest.mjs  生成 maps.json
```

---

## 六、验证结论

| 检查项 | 结果 |
|---|---|
| 解码 SHA-256 自证 | 逐字节一致 |
| 三角面 vs 站点清单 | 6/6 精确吻合 |
| GLB 容器/访问器校验 | 7/7 `errors 0 / warnings 0` |
| 图集 tile 恒定性 | 7/7 图集材质 100% 单 tile |
| 贴图完整性 | `missingTextures: []`，全部内嵌 |
| 坐标策略（镜像） | 6/6 按源策略表核对 |

---

## 七、免责声明

模型版权归**腾讯《三角洲行动》**所有。本仓库内容仅供**技术学习与研究**
使用，请勿用于任何商业用途。请以官方内容为准。

