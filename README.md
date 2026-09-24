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

## 本地与构建共用的数据流水线

本地开发与构建走同一条流水线（`scripts/pipeline.mjs`，零额外依赖），每一步都会打印
通过/失败结论；失败时指出卡在第几步、缺什么、如何修复，修好后重跑同一命令即可；
每次构建先清空 `dist/`，生成文件采用临时文件原子替换，不残留上一次的中间产物。

| 步骤 | 内容 |
| --- | --- |
| 1 依赖核对 | Node 版本、`package.json` 与 `package-lock.json` 是否一致、已安装版本是否满足声明 |
| 2 基线字符数据校验 | 校验 `data/baseline/braille-grade1.json`（A-Z、0-9、空格，点位 1-6，无重复/缺失），计算内容指纹并生成 `src/data/braille-data.ts` |
| 3 示例数据校验 | 校验 `data/samples/*.json`：缺失/为空报错；示例点位与 Unicode 必须能从基线推出，取值不合法时逐条说明原因 |
| 4 类型检查（仅构建） | `vue-tsc --noEmit` |
| 5 构建（仅构建） | 清空 `dist/` 后执行 `vite build` |
| 6 构建产物数据校验（仅构建） | 产物必须内嵌本次基线指纹、包含全部基线字符字形与全部示例字形，防止"开发看到的"与"构建出来的"不是同一版数据 |

命令：

```bash
cd frontend
npm install          # 按 package-lock.json 安装，本地与构建机版本一致（锁文件已入库）

npm run dev          # 自动先跑步骤 1-3（predev 钩子），通过后再启动 Vite
npm run build        # 完整跑步骤 1-6，全部通过才产出 dist/
npm run verify       # 同 build，适合提交前/CI 核对
npm run verify:data  # 只跑步骤 2-3，改完基线或示例后快速自检
```

修改字符数据的正确方式：只改 `data/baseline/braille-grade1.json`（基线，入库复用）
或 `data/samples/*.json`（示例，入库），不要手工编辑 `src/data/braille-data.ts`
——它由流水线生成并已加入 `.gitignore`。基线任何改动都会改变指纹，产物指纹校验
随即失败，直到重新构建。

## 启动（旧入口，等价于走流水线）
```bash
cd frontend && npm install && npm run dev
```
