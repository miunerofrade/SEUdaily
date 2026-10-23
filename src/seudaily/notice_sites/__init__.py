"""Bind registered source IDs to optional overrides; source metadata stays in JSON."""
from .jwc import JwcSite
from .webplus import WebplusSite
from ..notice_sources import WebplusSiteConfig

_SITE_OVERRIDES = {'jwc': JwcSite}


def create_site(config: WebplusSiteConfig, *, base_url: str = "") -> WebplusSite:
    return _SITE_OVERRIDES.get(config.key, WebplusSite)(config, base_url=base_url)
