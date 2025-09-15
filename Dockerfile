FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Create directory for token storage
RUN mkdir -p /app/data

# Expose port for OAuth callback
EXPOSE 8888

# Run the server
CMD ["npm", "start"]
