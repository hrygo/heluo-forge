# Heluo Brand Appearance

Provides the Heluo Forge Enterprise brand tokens: product name, in-app logo, accent colour, default theme, footer text and support link.

## Features

- **Brand tokens**: the in-package defaults ARE the Heluo Forge Enterprise identity (product name "河洛 Forge 企业版", accent `#2563EB`, default theme `system`, footer "企业内部使用", logo as the Cyber-Long coloured wordmark), exposed to the host via `ctx.provide('forge-brand')`.
- **Safe fallbacks**: every invalid field falls back to an upstream-compatible default with a recorded note; the product name and logo are never blank. The accent must keep at least a 3:1 non-text contrast ratio on both brand surfaces (`#FFFFFF` light, `#070C16` dark) or falls back to the default accent.
- **External references refused**: the logo and support link only accept a package-relative path / a well-formed URL; protocol, protocol-relative `//` or escaping `..` logo references are refused and the upstream logo is kept.
- **Length guard**: a product name longer than 32 characters is truncated with an ellipsis.

## Boundaries

- Branding never hides or weakens safety notices, approval or audit entries; no white labelling and no multi-tenant theming.
- Real consumption by the host brand/theme surface and dual-platform rendering coverage are pending real-host probing (design §12 open items); without a host seam the bundle degrades to providing tokens only and never fails the mount.
