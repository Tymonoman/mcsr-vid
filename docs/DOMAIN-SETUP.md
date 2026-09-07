# Pointing a domain at these pages

Both remaining Google gates need a **domain you control the DNS for**:

- the **YouTube API compliance audit**, which asks for an app/website URL — and until it passes,
  every video uploaded through `videos.insert` is locked to private, permanently, with no appeal
- **publishing the OAuth app**, which needs a homepage, privacy policy and terms URL on an
  authorized domain — and which is what stops Google expiring the refresh token every 7 days

`username.github.io` cannot be used for either. Google requires a Search Console **Domain
property**, verified by a DNS `TXT` record — *"You must verify the Domain Property (DNS-level),
rather than a 'URL prefix' or 'Site' property"* — and you cannot add DNS records to `github.io`.
So the domain has to be one you own. Any domain works; it does not have to be MCSR-related.

The pages themselves (`index.html`, `privacy.html`, `terms.html`) are already written and need no
changes — only somewhere to be served from.

## 1. Point the domain at GitHub Pages

At the registrar's DNS panel, for the apex (`example.com`):

| Type | Name | Value |
| --- | --- | --- |
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |

Optionally add `www` as a `CNAME` to `Tymonoman.github.io`.

## 2. Tell the repo its domain

```
echo example.com > docs/CNAME     # replace with the domain you bought
```

Commit it, then in **GitHub → Settings → Pages** set Source to `main` / `/docs`, enter the custom
domain, and tick *Enforce HTTPS* once the certificate is issued (a few minutes).

## 3. Verify it in Search Console

Add it as a **Domain** property, not a URL prefix — the URL-prefix option will verify happily and
then be rejected by Google Cloud, which is the trap. Copy the `TXT` record it gives you into the
registrar's DNS, wait for propagation, then verify.

Do this with **the same Google account that owns Cloud project 684668102575**, or the OAuth
system will not recognise the ownership.

## 4. Use it

In **Google Auth Platform → Branding**, add the authorized domain *first* — the URL fields are
rejected until it is registered — then:

- Homepage: `https://example.com/`
- Privacy policy: `https://example.com/privacy.html`
- Terms of service: `https://example.com/terms.html`

The same homepage and privacy URLs go on the audit form at
<https://support.google.com/youtube/contact/yt_api_form>.

## Afterwards

Re-run `npm run youtube-auth` once the app is published: tokens issued beforehand keep their
7-day clock. `scripts/preflight.sh` stops warning about expiry on its own once a token survives
past day 8, which only happens in production.
