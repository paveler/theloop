# certs/

This folder holds the **public root certificates of the Russian Trusted Root CA** (issued by
the Russian Ministry of Digital Development). They are needed for TLS to GigaChat: Sber signs
its hosts with a Russian CA that is not in Node's trust store, and without it the handshake
fails (SPEC §9.1). These are not secrets — the files are committed to git because images are
built from the repository.

## Files

- `russian_trusted_root_ca.crt` — root (Russian Trusted Root CA)
- `russian_trusted_sub_ca.crt` — intermediate (Russian Trusted Sub CA)

Both are PEM. Source: https://www.gosuslugi.ru/crt (direct links to the PEM files are on
`gu-st.ru`, a domain of the Ministry).

## Updating / verifying

```bash
curl -fsSL -o certs/russian_trusted_root_ca.crt https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
curl -fsSL -o certs/russian_trusted_sub_ca.crt  https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt

# sub is signed by root
openssl verify -CAfile certs/russian_trusted_root_ca.crt certs/russian_trusted_sub_ca.crt
# compare the root fingerprint by eye with the one published at gosuslugi.ru/crt
openssl x509 -in certs/russian_trusted_root_ca.crt -noout -subject -enddate -fingerprint -sha256
```

## How it is used

- **Docker:** the `Dockerfile` copies `certs/*.crt` into the image trust store
  (`update-ca-certificates`) and sets `NODE_EXTRA_CA_CERTS`.
- **Locally:** `npm run smoke:gigachat` concatenates both files into
  `certs/russian_bundle.pem` (not committed) and runs smoke with
  `NODE_EXTRA_CA_CERTS`. For `npm run dev` do the same by hand:
  `NODE_EXTRA_CA_CERTS=certs/russian_bundle.pem npm run dev`.

`rejectUnauthorized: false` is forbidden. Anthropic / OpenAI / DeepSeek / GLM need no extra
certificates — only GigaChat does.
