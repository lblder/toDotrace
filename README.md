# TodoAgent · 科研计划与学习轨迹

个人科研工作台：实验室打卡、计划待办、番茄计时与学习轨迹统计。
使用 React、TypeScript、Express 和 SQLite，支持多账号及邀请码注册。

## 功能

- 到达、暂离、返回和离开记录，连续与累计打卡统计。
- 我的一天、重要任务、计划、项目管理及重复任务。
- 单任务专注计时，暂离或离开时停止计时。
- 完成日历、在场时长和按项目划分的专注统计。

## 开发与运行

需要 Node.js 22 或更高版本。

```sh
npm ci
npm run dev
```

单进程运行：

```sh
npm run build
npm start
```

默认服务端口为 8788。首次访问创建管理员，其他账号通过邀请码注册。
主机和端口可通过 `TODOAGENT_API_HOST`、`TODOAGENT_API_PORT` 设置。
macOS 可使用根目录的 `启动.command`。

## 验证

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

`npm run verify` 顺序运行类型检查、测试、构建和浏览器测试。

## 数据与备份

数据保存在 `data/app.db`，该目录不进入 Git。
服务停止时可复制数据库；运行期间应使用 SQLite 一致快照，避免遗漏 WAL 中的数据。

## 当前限制

- 导入导出功能尚未完成，覆盖导入的事件语义仍有已知问题，不应作为可用功能使用。
- 部分打卡更正入口尚未接通。
- 浏览器自动化测试目前覆盖 Chromium。
- 超过 18 小时或顺序异常的到访时长标记为待核对，不计入时长统计。
- 持有效邀请码者可能通过注册反馈判断用户名是否已注册。

## 仓库范围

此仓库包含应用源码、测试及运行配置。私有部署工具、内部设计文档和运行数据不随代码发布。
开发历史保留；为去除私有文件与个人邮箱，历史提交 ID 已重新生成。
