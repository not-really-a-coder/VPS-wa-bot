FROM node:20-bookworm-slim

# Install system dependencies including chromium for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    python3 \
    python3-pip \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Set env vars to skip puppeteer's chromium download and use the system one
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copy package files and python requirements
COPY package.json requirements.txt ./

# Install dependencies using only 1 core to prevent CPU lockup on VPS
RUN npm install --jobs=1
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Copy the rest of the application code
COPY . .

# Expose port
EXPOSE 8000

# Start the application
CMD ["npm", "start"]
