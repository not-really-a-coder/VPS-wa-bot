# Stage 1: Build the Vite application
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm ci

# Copy the rest of the frontend source code
COPY . .

# Build the application (outputs to dist/)
RUN npm run build

# Stage 2: Serve with Nginx
FROM nginx:alpine

# If vite.config.ts base is '/bots/', we should serve from a '/bots' subdirectory 
# so the paths match up correctly.
RUN mkdir -p /usr/share/nginx/html/bots
COPY --from=builder /app/dist /usr/share/nginx/html/bots

# Expose port 80
EXPOSE 80

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]
