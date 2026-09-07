# Pointing a domain at these pages

Both remaining Google gates need a **domain you control the DNS for**:

- the **YouTube API compliance audit**, which asks for an app/website URL — and until it passes,
  every video uploaded through `videos.insert` is locked to private, permanently, with no appeal
- **publishing the OAuth app**, which needs a homepage, privacy policy and terms URL on an
  authorized domain — and which is what stops Google expiring the refresh token every 7 days

`username.github.io` cannot be used for either. Google requires a Search Console **Domain
property**, verified by a DNS `TXT` record — *"You must verify the Domain Property (DNS-level),
rather than a 'URL prefix' or 'Site' property"* — and you cannot add DNS records to `github.io`.
So the domain has to be one you own.

The pages themselves (`index.html`, `privacy.html`, `terms.html`) are already written and need no
changes — only somewhere to be served from.

## The domain

`sezamki.site`, on Cloudflare nameservers. Its apex already points at 89.239.117.28, so these
pages go on a **subdomain** and leave that alone: `mcsr.sezamki.site`, set in `docs/CNAME`.
Change that one line if you want a different name — it is the only place it is written down.

## 1. Point the subdomain at GitHub Pages

One record in Cloudflare's DNS panel:

| Type | Name | Target | Proxy |
| --- | --- | --- | --- |
| CNAME | `mcsr` | `Tymonoman.github.io` | **DNS only (grey cloud)** |

The proxy setting is the part that bites. Orange-cloud it and GitHub cannot reach the domain to
issue its certificate, so *Enforce HTTPS* stays greyed out and the site serves over plain HTTP —
which Google will not accept for a privacy policy URL. Leave it grey at least until the
certificate is issued. If you turn the proxy on afterwards, Cloudflare's SSL/TLS mode must be
**Full**, never **Flexible**: Flexible plus GitHub Pages is a redirect loop.

No apex records change. 89.239.117.28 keeps serving whatever it serves.

## 2. Turn Pages on

`docs/CNAME` already contains the subdomain, so in **GitHub → Settings → Pages** set Source to
`main` / `/docs`. GitHub reads the file and fills the custom domain in for you. Wait for the
certificate, then tick *Enforce HTTPS*.

Check `https://mcsr.sezamki.site/privacy.html` loads before going near the Google forms — both
of them reject a URL that does not resolve.

## 3. Verify it in Search Console

Add **`sezamki.site`** as a **Domain** property, not a URL prefix — the URL-prefix option
verifies happily and is then rejected by Google Cloud, which is the trap. A Domain property
covers every subdomain, so verifying the apex covers `mcsr.sezamki.site` too; you do not verify
the subdomain separately.

Search Console gives a `TXT` record. Add it in Cloudflare on the apex (Name `@`), wait a minute,
then verify. Cloudflare propagates quickly.

Do this with **the same Google account that owns Cloud project 684668102575**, or the OAuth
system will not recognise the ownership.

## 4. Use it

In **Google Auth Platform → Branding**, add the authorized domain *first* — the URL fields are
rejected until it is registered — then:

- Authorized domain: `sezamki.site` — the registrable domain, not the subdomain
- Homepage: `https://mcsr.sezamki.site/`
- Privacy policy: `https://mcsr.sezamki.site/privacy.html`
- Terms of service: `https://mcsr.sezamki.site/terms.html`

The same homepage and privacy URLs go on the audit form at
<https://support.google.com/youtube/contact/yt_api_form>.

## Afterwards

Re-run `npm run youtube-auth` once the app is published: tokens issued beforehand keep their
7-day clock. `scripts/preflight.sh` stops warning about expiry on its own once a token survives
past day 8, which only happens in production.
