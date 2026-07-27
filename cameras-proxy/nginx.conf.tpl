# cameras.mbfdhub.com nginx template — MBFD public camera proxy (GMKtec)
# SECURITY: the live token is injected at render time (mode 0600). This
# template contains only the placeholder token marker, never the secret.
# Render with cameras-proxy/render-config.sh from a protected runtime source.
# CRITICAL HLS: MediaMTX cookie-check redirect drops /hls/ prefix. proxy_redirect
# rewrites it back. absolute_redirect off + port_in_redirect off ensure the
# redirect is RELATIVE (no http:// scheme or :8120 port leaks to the browser).

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
    absolute_redirect off;
    port_in_redirect off;
    server_name_in_redirect off;
    root /usr/share/nginx/html;
    index index.html;

    location = /healthz { return 200 "ok"; add_header Content-Type text/plain; }

    location / {
      try_files $uri /index.html;
      add_header Cache-Control "no-cache";
    }
    location = /index.html { add_header Cache-Control "no-store"; }

    location /api/ {
      # No URI suffix: preserve the exact post-proxy path signed by Media
      # Control, including its percent-encoding. Query ordering is canonicalized
      # by the shared signer/verifier.
      proxy_pass http://kamrui_api;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Api-Token "__CAMERA_API_TOKEN__";
      proxy_set_header Connection "";
      proxy_connect_timeout 5s;
      proxy_read_timeout 30s;
      proxy_send_timeout 10s;
      limit_except GET POST PATCH DELETE { deny all; }
      add_header X-Proxy-Source "kamrui" always;
    }

    location ^~ /hls/ {
      proxy_pass http://kamrui_hls/;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-Host cameras.mbfdhub.com;
      proxy_set_header X-Forwarded-Port 443;
      proxy_redirect ~^/(.*)$ /hls/$1;
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
