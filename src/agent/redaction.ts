const sensitiveKey = /^(?:password|passwd|secret|api[_-]?key|cookie|authorization|access[_-]?token|refresh[_-]?token|signature)$/i;
export function redactText(text: string): string {
    for (const [key, value] of Object.entries(process.env)) {
        if (value && /PASSWORD|SECRET|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN/i.test(key))
            text = text.split(value).join('[已脱敏]');
    }
    return text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [已脱敏]')
        .replace(/\b(password|passwd|api[_-]?key|cookie|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[已脱敏]');
}
export function redactValue(value: any): any {
    if (typeof value === 'string')
        return redactText(value);
    if (Array.isArray(value))
        return value.map(redactValue);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? '[已脱敏]' : redactValue(item)]));
    return value;
}
