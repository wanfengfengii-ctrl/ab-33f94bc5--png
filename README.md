# PNG Audit API

显微成像流水线归档前的严格 PNG 审计服务。它不信任任何查看器的容错解码：
逐字节验证 PNG 文件结构，并将解码后的像素与文件结构做唯一对应，返回图像
元数据与原始通道字节的 SHA-256，避免损坏或歧义的 PNG 进入归档。

零第三方依赖，仅使用 Node.js（≥ 20）内置的 `http` / `zlib` / `crypto`。

## 接口

### `POST /api/png/audit`

- 请求：`Content-Type: image/png`，原始 PNG 字节，正文 **不超过 8 MiB**。
- 成功 `200`：

```json
{
  "width": 13,
  "height": 7,
  "colorType": 0,
  "pixelBytes": 91,
  "sha256": "4d865ce901fbc8c69fb9e6a4a511279e22739ec18efb5c21e5368c4ed9e47edb"
}
```

* `colorType`：`0` = 灰度，`6` = RGBA（唯一接受的两类）。
* `pixelBytes`：宽 × 高 × 通道数（灰度 1，RGBA 4）。
* `sha256`：**逐行原始通道字节**（还原五种行过滤器之后、不含每行过滤器
  类型字节）顺序拼接后的小写 SHA-256。

- 失败 `422`（结构/编码问题）或 `4xx`（传输问题）：

```json
{ "error": { "code": "CRC_MISMATCH", "message": "CRC check failed in chunk IDAT", "chunk": 2 } }
```

错误码稳定；能定位时附带首个失败块号 `chunk`（从 1 开始）或首个失败扫描线
`line`（从 1 开始）。

### `GET /healthz`

健康检查，返回 `200 {"status":"ok"}`。

## 接受条件（全部满足）

* PNG 签名正确；块长度自洽、CRC32（覆盖类型+数据）全部有效。
* 块顺序合法：`IHDR` 唯一且最先；`IDAT` 构成**单一且连续**的块序列
  （IDAT 之间插入任何块都会被拒）；`IEND` 最后，其后**不得有尾随字节**。
* 未知**关键块**（首字母大写的非标准类型）一律拒绝；未知辅助块按 PNG 规范
  忽略，但其长度与 CRC 仍被校验。
* IHDR：8 位、非交错（interlace 0）、颜色类型 0 或 6；宽高均在 1..4096；
  压缩/过滤方法为 0。拒绝 Adam7、16 位、RGB/GA/调色板等类型。
* IDAT 拼接后是**恰好一个** zlib 流：拒绝流后垃圾字节、拼接的第二个流、
  截断流。
* 解压长度必须**恰好**等于 `高 × (宽 × 通道数 + 1)`：多则报
  `OUT_OF_BOUNDS_DECOMPRESSED_DATA`，少则报 `TRUNCATED_SCANLINE` 并给出
  第一个不完整行号。
* 正确还原 None(0)/Sub(1)/Up(2)/Average(3)/Paeth(4) 五种标准行过滤器；
  未知过滤字节按 `INVALID_FILTER_TYPE` 及行号拒绝。

### 错误码一览

| code | 含义 |
|---|---|
| `INVALID_SIGNATURE` | PNG 签名缺失/错误 |
| `TRUNCATED_CHUNK` / `INVALID_CHUNK_TYPE` | 块截断 / 类型字节非法 |
| `CRC_MISMATCH` | 块 CRC 校验失败（附 `chunk`） |
| `UNKNOWN_CRITICAL_CHUNK` | 不支持的关键块（附 `chunk`） |
| `BAD_CHUNK_ORDER` / `NONCONTIGUOUS_IDAT` | 块顺序错误 / IDAT 不连续 |
| `MISSING_IDAT` / `MISSING_IEND` / `INVALID_IEND` | 关键块缺失或非法 |
| `TRAILING_BYTES` | IEND 后存在尾随字节（附 `chunk`） |
| `INVALID_DIMENSIONS` / `UNSUPPORTED_BIT_DEPTH` / `UNSUPPORTED_COLOR_TYPE` | IHDR 约束不满足 |
| `INTERLACED_UNSUPPORTED` | Adam7 交错图像 |
| `ZLIB_ERROR` / `ZLIB_TRAILING_BYTES` | zlib 流损坏 / 流外多余字节 |
| `OUT_OF_BOUNDS_DECOMPRESSED_DATA` | 解压数据多于全部过滤扫描线 |
| `TRUNCATED_SCANLINE`（附 `line`） | 解压数据不足，扫描线截断 |
| `INVALID_FILTER_TYPE`（附 `line`） | 行使用未知过滤器 |
| `UNSUPPORTED_MEDIA_TYPE` / `BODY_TOO_LARGE` / `EMPTY_BODY` 等 | HTTP 层错误 |

## 本地运行（无需依赖安装）

```bash
npm start                 # 默认 0.0.0.0:8080，可用 PORT 覆盖
npm test                  # Node 内置测试运行器（49 个用例）
npm run build             # node --check 语法检查
BASE_URL=http://127.0.0.1:8080 npm run smoke   # HTTP 冒烟（先启动服务）
```

## Docker / Docker Compose

```bash
# 构建并启动 API；宿主机端口可配置
PNG_AUDIT_PORT=9090 docker compose up -d --build
curl -s http://localhost:9090/healthz

# 一次性验证服务：等待 api 健康后，自行完成
#   构建检查 + 单元测试 + 合法/损坏 PNG 的 HTTP 冒烟，
# 并以自身退出码报告结果（0 = 全部通过）
docker compose build verify
docker compose up --abort-on-container-exit --exit-code-from verify verify

# 或使用包装脚本（结束后自动清理）
PNG_AUDIT_PORT=9090 ./verify.sh
```

`docker-compose.yml` 中：

* `api` 发布端口为 `${PNG_AUDIT_PORT:-8080}:8080`，并配置了 Compose 与镜像
  双层 healthcheck。
* `verify` 通过 `depends_on: condition: service_healthy` **等待 api 健康后**
  才启动；它只运行一次，退出码即测试结果，不重启。

## 项目结构

```
src/png.js          严格 PNG 解析、CRC、zlib 边界、五种过滤器还原与 SHA-256
src/server.js       HTTP 服务（/api/png/audit、/healthz）
src/healthcheck.js  容器健康检查
test/fixtures.js    测试用最小 PNG 编码/变异工具
test/png.test.js    单元测试（node:test）
test/smoke.mjs      HTTP 冒烟（合法/损坏矩阵，等待健康）
Dockerfile          多阶段构建（build 语法检查 + runtime 非 root 运行）
docker-compose.yml  api + 一次性 verify 服务
verify.sh           一键验证包装脚本
```
