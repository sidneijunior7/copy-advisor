// Who runs the Mirror: what an online shop must show (Decreto 7.962/2013, art. 2º) and the controller of the personal
// data (LGPD, art. 9º). One place, so the footers, the Terms and the Privacy Policy never disagree
export const COMPANY = {
    brand: 'Trademetric',
    legalName: 'Sidnei da Silva Santos Junior LTDA',
    cnpj: '64.539.704/0001-10',
    email: 'trademetric@trademetric.com.br', // Support and the data holder's channel
} as const;

// The version of the Terms of Use and of the Privacy Policy on the site. The sign-up sends it, and the API keeps
// which one each user accepted: bump it, with privacy.TERMS_VERSION, whenever either text changes
export const LEGAL_VERSION = '1.0';
export const LEGAL_DATE = '13 de novembro de 2026';
