# cameras.mbfdhub.com nginx template — MBFD public camera proxy (GMKtec)
#
# Mounted into the mbfd-cameras nginx container as /etc/nginx/nginx.conf.
# SECURITY: the live file has the camera API token injected into the /api/
# and /health/kamrui locations (proxy_set_header X-Api-Token). This committed
# TEMPLATE uses a placeholder; deploy injects the value from a protected
# secret and sets the file mode 0600.
#
# Proxy chain: cameras.mbfdhub.com (Cloudflare Access) -> :8120 (loopback)
# -> /api/  -> Kamrui camera-control API (192.168.1.122:8200)
# -> /hls/  -> Kamrui MediaMTX HLS    (192.168.1.122:8888)
#
# CRITICAL HLS redirect handling: MediaMTX issues a cookie-check redirect
#   /hls/annke-preview/index.m3u8 -> /annke-preview/index.m3u8?cookieCheck=1
# whose Location DROPS the /hls/ prefix. proxy_redirect ~^/(.*)$ /hls/$1
# rewrites the upstream redirect back under the public /hls/ namespace so
# hls.js follows it to valid HLS, not the static index.html fallback.
# Without this, the redirect escapes /hls/, hits location / (static site),
# and returns HTML 200 -> hls.js fails silently.

worker_processes 1;
events { worker_connections 256; }
http {
  include       /etc/nginx/mime.types;
  default_type  application/octet-stream;
  sendfile on;
  tcp_nopush on;
  types { video/iso.segment m4s; }

  upstream kamrui_api { server 192.168.1.122:8200; keepalive 8; }
  upstream kamrui_hls { server 192.168.1.122:8888; keepalive 4; }

  server {
    listen 127.0.0.1:8120;
    server_name cameras.mbfdhub.com;
    root /usr/share/nginx/html;
    index index.html;

    location = /healthz { return 200 "ok"; add_header Content-Type text/plain; }

    location / {
      try_files $uri /index.html;
      add_header Cache-Control "no-cache";
    }
    location = /index.html { add_header Cache-Control "no-store"; }

    location /api/ {
      proxy_pass http://kamrui_api/api/;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Api-Token "__CAMERA_API_TOKEN__";   # injected at deploy (mode 0600 file)
      proxy_set_header Connection "";
      proxy_connect_timeout 5s;
      proxy_read_timeout 30s;
      proxy_send_timeout 10s;
      limit_except GET POST { deny all; }
      add_header X-Proxy-Source "kamrui" always;
    }

    location ^~ /hls/ {
      proxy_pass http://kamrui_hls/;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_redirect ~^/(.*)$ /hls/$1;     # keep cookie-check redirect under /hls/
      proxy_buffering off;
      proxy_request_buffering off;
      proxy_set_header Connection "";
      proxy_read_timeout 60s;
      add_header Cache-Control "no-cache";
      add_header X-Proxy-Source "kamrui-hls" always;
    }

    location /health/kamrui {
      proxy_pass http://kamrui_api/api/health;
      proxy_http_version 1.1;
      proxy_set_header X-Api-Token "__CAMERA_API_TOKEN__";
      proxy_set_header Connection "";
      proxy_connect_timeout 3s;
      proxy_read_timeout 5s;
    }

    location /vendor/ { add_header Cache-Control "public, max-age=86400"; }
  }
}
