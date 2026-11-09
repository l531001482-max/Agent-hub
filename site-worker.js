// 落地页的入口：www 和 http 统一 301 到 https://agentsworkspace.dev，其余交给 docs/ 里的静态文件
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'www.agentsworkspace.dev' || url.protocol === 'http:') {
      url.hostname = 'agentsworkspace.dev';
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
