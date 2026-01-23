# tavily-proxy

Lightweight proxy for Tavily MCP. It rotates API keys from `keys.json`, so clients only
configure the proxy URL and do not send `tavilyApiKey`.

## Quick start

```bash
npm install
```

Edit `keys.json` and add multiple Tavily API keys:

```json
["key_1", "key_2", "key_3"]
```

Start the service:

```bash
npm run build
npm run start
```

Client configuration:

```
{
  "mcpServers": {
    "tavily": {
      "url": "http://localhost:8787"
    }
  }
}
```

## Notes

- `keys.json` is a JSON array of API keys.
- Round-robin selection: each request uses the next key.
- `keys.json` changes are watched; reloading resets the key index to 0.
- If a client uses the root path `/`, it forwards to the default `/mcp/` path.
- Request logging is always enabled and redacts `tavilyApiKey`.
- Retries use the next key on auth/rate-limit errors or retryable server errors (non-idempotent methods only retry on auth/rate-limit).

## Optional environment variables

- `PORT`: listening port (default `8787`).
- `KEYS_FILE`: keys file path (default `./keys.json`).
- `TAVILY_MCP_BASE_URL`: upstream MCP URL (default `https://mcp.tavily.com/mcp/`).
- `MAX_BODY_BYTES`: max request body size in bytes (default `1048576`).
- `MAX_ERROR_BODY_BYTES`: max buffered error body size in bytes (default `262144`).

## Docker deployment

Build and run with Docker:

```bash
docker build -t tavily-proxy .
docker run --rm -p 8787:8787 -v "$(pwd)":/data:ro -e KEYS_FILE=/data/keys.json tavily-proxy
```

Build and run with Docker Compose:

```bash
docker compose up --build
```

After editing `keys.json`, the service reloads keys automatically.
