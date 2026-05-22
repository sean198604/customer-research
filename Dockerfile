FROM nginx:alpine
COPY customer-research.html /usr/share/nginx/html/index.html
COPY favicon.ico /usr/share/nginx/html/favicon.ico
EXPOSE 80
