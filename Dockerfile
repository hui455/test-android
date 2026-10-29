# BugShot 服务端（不带窗口）。先在仓库根目录执行 npm ci && npm run build:server
#   docker build -t bugshot-server .
#   docker run -d --name bugshot --network host -v /volume1/bugshot:/data bugshot-server
# 用 host 网络，测试人员的 BugShot 才能在局域网里自动找到它（UDP 17801）；
# 不方便用 host 网络时改成 -p 17800:17800，客户端手动填地址即可。
FROM node:22-alpine
WORKDIR /app
COPY out/server/bugshot-server.cjs ./
ENV BUGSHOT_DATA=/data
VOLUME /data
EXPOSE 17800 17801/udp
CMD ["node", "bugshot-server.cjs"]
