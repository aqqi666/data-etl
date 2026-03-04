# 智能 ETL 助手

通过自然语言对话完成数据建模与加工：连接数据库 → 选择基表 → 定义目标表 → 字段映射 → 校验与溯源。真实连接 MySQL，DDL/DML 先展示后确认执行。

## 功能概览

- **对话式流程**：连接库、选基表、建表、映射、验证、溯源，全程自然语言引导
- **真实执行**：后端连接你的 MySQL 执行 SQL，结果以表格 + 返回码形式回显，不编造
- **安全确认**：所有 DDL、DML 先展示 SQL，用户确认后才执行
- **自我纠正**：执行失败（如列不存在）时自动查表结构并给出修正 SQL

## 技术栈

- 前端：React + TypeScript + Vite + Tailwind CSS + Zustand
- 后端（Node.js 版）：Node.js + Express + mysql2
- 后端（Python 版）：FastAPI + LangGraph + aiomysql（支持 Tool Calling）
- 模型：DeepSeek API（意图解析 + 对话回复）

## 本地运行

### Node.js 版后端

#### 1. 安装依赖

```bash
npm install
```

#### 2. 配置环境变量

在项目根目录创建 `.env`，配置 DeepSeek API Key：

```
DEEPSEEK_API_KEY=your_deepseek_api_key
```

#### 3. 启动

```bash
# 同时启动后端 + 前端（推荐）
npm run dev:all

# 或分别启动
npm run dev:server   # 后端 http://localhost:3000
npm run dev          # 前端 Vite 开发服务器
```

### Python 版后端

> 需要 Python 3.12+，基于 FastAPI + LangGraph 构建，支持 LLM Tool Calling 模式。

#### 1. 安装依赖

```bash
cd server_py
pip install -r requirements.txt
```

#### 2. 配置环境变量

在 `server_py/` 目录下创建 `.env`：

```
LLM_API_KEY=your_api_key
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
```

#### 3. 启动

```bash
cd server_py
python -m server_py.main   # 默认 http://localhost:3000
```

### 前端

浏览器访问前端地址（Vite 默认如 `http://localhost:5173`），在对话中输入 MySQL 连接串即可开始。连接串示例：`mysql://username:password@host:3306/database_name`。

## 项目结构

```
├── server/              # Node.js 后端（Express API、意图解析、数据库执行）
├── server_py/           # Python 后端（FastAPI + LangGraph）
│   ├── main.py          # FastAPI 应用入口
│   ├── config.py        # 配置管理
│   ├── db/              # 数据库连接与操作
│   ├── llm/             # LLM 客户端与工具定义
│   ├── graphs/          # LangGraph 对话流程图
│   ├── routers/         # API 路由（chat、mapping、dml、lineage 等）
│   └── requirements.txt # Python 依赖
├── src/                 # 前端 React 应用
│   ├── components/      # 对话、输入、消息展示等
│   ├── store.ts         # 对话状态与演示流程
│   └── types.ts         # ETL 步骤与类型定义
├── .env                 # 环境变量（需自行创建，勿提交）
└── package.json
```

## License

ISC
