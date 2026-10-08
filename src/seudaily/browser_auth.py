"""Shared CAS page selectors for the explicit browser login fallback."""

USERNAME_SELECTOR = "input[placeholder*='一卡通'], input[placeholder*='唯一ID'], input[placeholder*='ID'], .input-username-pc"
PASSWORD_SELECTOR = "input[type='password'], input[placeholder*='密码']"
LOGIN_SELECTOR = "button:has-text('登 录'), .login-button-pc, .ant-btn-primary"


def login_fields(page):
    return (
        page.locator(USERNAME_SELECTOR).first,
        page.locator(PASSWORD_SELECTOR).first,
        page.locator(LOGIN_SELECTOR).first,
    )
