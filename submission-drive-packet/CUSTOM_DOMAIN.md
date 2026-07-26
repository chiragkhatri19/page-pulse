# Custom domain plan

Recommended submission domain: `scan.chiragships.site`.

Why this subdomain:

- It uses the existing `chiragships.site` domain.
- It keeps the personal root domain free for portfolio use.
- It is short and descriptive for this project.
- Public DNS currently does not resolve `scan.chiragships.site`, so it appears available.

Current production URL remains:

```text
https://page-pulse-9riw.onrender.com
```

Do not replace the submitted live URL until Render verifies the custom domain and the HTTPS certificate is active.

## Render setup

Render's custom-domain flow is:

1. Add the custom domain in the Render service settings.
2. Configure DNS with the domain provider.
3. Verify the domain in Render.

Source: https://render.com/docs/custom-domains

## Recommended DNS record

Add this DNS record at the DNS provider for `chiragships.site`:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| `CNAME` | `scan` | `page-pulse-9riw.onrender.com` | 5 minutes or automatic |

Render's DNS docs recommend a CNAME for non-root subdomains.

Source: https://render.com/docs/configure-other-dns

## Render dashboard steps

1. Open the Render dashboard.
2. Select the `page-pulse` web service.
3. Go to **Settings**.
4. Find **Custom Domains**.
5. Add `scan.chiragships.site`.
6. Add the CNAME record above in the DNS provider.
7. Return to Render and click **Verify**.
8. Wait for Render to issue the TLS certificate.
9. Open `https://scan.chiragships.site`.

Render keeps the existing `onrender.com` URL active after a custom domain is added, so this does not break the current submission link.

## DNS notes

- Remove any conflicting `A`, `AAAA`, `CNAME`, redirect or parking records for `scan`.
- Render recommends removing `AAAA` records when configuring domains because Render uses IPv4 for custom domains.
- If the domain is managed by Cloudflare, keep the record DNS-only while verifying if Render asks for that.

## After it works

Once `https://scan.chiragships.site` loads successfully:

1. Update `README.md`, `SUBMISSION.md`, `SUBMISSION_LINKS.md`, `openapi.yaml`, and `public/index.html` canonical/API examples.
2. Keep the Render URL as a fallback link in `PROOF.md`.
3. Run `npm run build`, `npm test`, and live checks against the custom domain.
4. Commit and push the URL update.

---

Built for [Digital Heroes Training Task](https://digitalheroesco.com).
