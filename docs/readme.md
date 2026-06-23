# 安装
cd C:\project\my-ui-agent
npm ci
npx playwright install chromium
npm test
npm run typecheck
npm run build

新项目没有锁文件时，用：
npm install
有 package-lock.json 时优先用 npm ci。