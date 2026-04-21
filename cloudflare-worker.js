/**
 * Archive.org CDN Proxy - Free Tier Safe
 * Handles 100GB/day by caching smartly
 * Version: 6.2 (Oracle-optional compatible)
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/ia\//, '');
    
    // Health check
    if (!path || path === '/') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'archive-proxy',
        version: '6.2',
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Only cache small files and first chunks (stay under free quota)
    const range = request.headers.get('Range') || '';
    const isSmallRequest = !range || range.startsWith('bytes=0-');
    
    const iaUrl = `https://archive.org/download/${path}`;
    const cache = caches.default;
    
    // Try cache first for small requests
    let response = isSmallRequest ? await cache.match(request) : null;
    
    if (!response) {
      try {
        response = await fetch(iaUrl, {
          headers: {
            'Range': range,
            'User-Agent': 'Archive-Drive/6.2'
          },
          cf: {
            cacheTtl: 86400,
            cacheEverything: true,
            mirage: true,
            polish: 'off'
          }
        });

        // Clone response for modification
        response = new Response(response.body, response);
        
        // Add CORS and caching headers
        response.headers.set('Access-Control-Allow-Origin', '*');
        response.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        response.headers.set('Access-Control-Allow-Headers', 'Range, Content-Type');
        response.headers.set('Accept-Ranges', 'bytes');
        response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        response.headers.set('X-Proxy', 'cloudflare-worker-6.2');
        response.headers.delete('Set-Cookie');
        response.headers.delete('X-Frame-Options');
        
        // Cache only small files and first chunks (saves quota)
        if (isSmallRequest && (response.status === 200 || response.status === 206)) {
          const contentLength = parseInt(response.headers.get('Content-Length') || '0');
          if (contentLength < 50 * 1024) { // Only cache <50MB
            await cache.put(request, response.clone());
          }
        }
      } catch (err) {
        return new Response(`Upstream error: ${err.message}`, { status: 502 });
      }
    }
    
    return response;
  }
}
