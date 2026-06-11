# Contributing

Thanks for your interest! This plugin is intentionally small — one file, one
dependency — and contributions that keep it that way are the easiest to merge.

## Reporting bugs

Open an issue with:

- UniFi OS and Protect versions (Settings → Updates)
- Console model (UDM SE, UDM Pro, UNVR, …)
- The Homebridge startup log for the plugin (**redact your API key**)
- What you expected vs. what happened

## Pull requests

1. Fork, branch from `main`
2. Keep changes focused; one fix/feature per PR
3. `node --check index.js` must pass
4. If you add a config option, update `config.schema.json` **and** the README
   table

## Testing against your console

The quickest way to verify the API surface on your firmware:

```bash
KEY="your_api_key"; C="your_controller_ip"
curl -sk -H "X-API-KEY: $KEY" "https://$C/proxy/protect/integration/v1/meta/info"
curl -sk -H "X-API-KEY: $KEY" "https://$C/proxy/protect/integration/v1/arm-profiles"
curl -sk -H "X-API-KEY: $KEY" "https://$C/proxy/protect/integration/v1/nvrs"
```
