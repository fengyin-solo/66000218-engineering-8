# solo-6600021: 盲文翻译与触觉学习器

## 技术栈
- Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS + SVG + Vibration API

## 核心特性
1. **中英文→盲文实时翻译**：Braille Grade 1 编码，Unicode 盲文字符输出
2. **6 点阵 SVG 大尺寸渲染**：可交互点击选择盲文点阵
3. **Vibration API 触觉模拟**：答对/答错不同振动模式
4. **训练模式**：看字符选盲文，正确率统计，历史记录
5. **速查表**：26 字母 + 数字完整盲文对照
6. **可打印 PDF 导出**：翻译结果导出为文本文件

## 数据基线与示例数据（本地保存，开发与构建共用）
- `data/braille-baseline.json`：盲文基线数据（26 字母 + 10 数字 + 空格，含点阵与 Unicode）。
  提交在仓库中本地复用；`src/utils/braille.ts` 不再硬编码，直接从这份 JSON 派生映射。
- `data/samples.json`：翻译示例，每条的期望点阵与期望 Unicode 必须与基线一致。
- Vite 插件（`frontend/vite.config.ts`）在 **dev server 与 build 两条路径上**加载并校验同一份基线，
  并通过虚拟模块 `virtual:braille-data` 注入数据版本与指纹；界面页脚会显示当前指纹。

## 统一流水线（本地与构建共用同一条）
一条命令串起「依赖核对 → 清理 → 基线校验 → 示例校验 → 类型检查 → 构建 → 产物核验」，
每一步都打印 ✓ PASS / ✗ FAIL；失败时指出**卡在哪一步、缺什么/为什么不合法、怎么修**，修复后重跑即可，
开头的清理步骤会删除上一次的 `frontend/dist/`，不残留旧产物。

```bash
# 首次（或换机器/删过 node_modules）：按本机平台安装依赖
npm run setup

# 完整流水线（等价于 CI 构建）
npm run verify

# 本地开发：先跑 依赖核对+基线校验+示例校验，再起 dev server
npm run dev
# 确认不做数据预检、直接起 dev（基线仍由 Vite 插件强制校验）
npm run dev:raw
```

也可以单独执行某一步：

```bash
node scripts/braille/pipeline.mjs check-deps      # 只核对依赖
node scripts/braille/pipeline.mjs verify-samples  # 只校验示例数据
node scripts/braille/pipeline.mjs verify-build    # 只核验已构建产物
```

### 各步骤说明
| 步骤 | 检查内容 | 失败时的典型提示 |
| --- | --- | --- |
| check-deps | Node 版本；`frontend/node_modules` 是否存在；package.json 声明的包是否就位、主版本是否匹配 | 缺哪个包，执行 `npm run setup` |
| clean | 删除 `frontend/dist/`，保证不混入上次产物 | — |
| sync-baseline | 基线存在且为合法 JSON；点阵只能是 1-6；Unicode 必须与点阵一致；A-Z/0-9/空格齐全；同类内无重复 | 指出第几条、哪个字符、哪个值非法 |
| verify-samples | 示例文件存在；input 非空且只含基线字符；期望点阵/Unicode 与基线一致 | 逐条说明缺失字段或取值不合法的原因 |
| typecheck | `vue-tsc --noEmit` | 类型错误位置 |
| build | `vite build`，注入基线指纹 | 构建错误 |
| verify-build | 产物中包含当前基线指纹；37 个字符的盲文 Unicode 全部进了产物；index.html 存在 | “构建用的数据不是本地最新基线” |

> 基线变更后务必重跑 `npm run verify`：若示例期望值未同步更新，`verify-samples` 会失败；
> 若产物是旧基线构建的，`verify-build` 会失败。
