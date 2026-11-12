// Formats up to 11 digits as 000.000.000-00
export function formatCpf(value: string): string {
    const digits = value.replace(/\D/g, '').slice(0, 11);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
    if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9, 11)}`;
}

export function cleanCpf(value: string): string {
    return value.replace(/\D/g, '');
}

export function isValidCpf(value: string): boolean {
    const digits = cleanCpf(value);
    if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
    for (const len of [9, 10]) {
        let sum = 0;
        for (let i = 0; i < len; i++) {
            sum += Number(digits[i]) * (len + 1 - i);
        }
        const check = (sum * 10) % 11;
        if ((check === 10 ? 0 : check) !== Number(digits[len])) return false;
    }
    return true;
}

