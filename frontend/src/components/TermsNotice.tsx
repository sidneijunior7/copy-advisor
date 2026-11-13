import { cn } from '../lib/utils';

export const TERMS_PATH = '/termos';
export const PRIVACY_PATH = '/privacidade';

const link = 'font-medium text-primary underline-offset-4 hover:underline';

// Under every button that creates an account: the links open in another tab, so the sign-up keeps its place
export default function TermsNotice({ action = 'criar sua conta', className }: { action?: string; className?: string }) {
    return (
        <p className={cn('text-center text-xs text-muted-foreground', className)}>
            Ao {action} você aceita os{' '}
            <a href={TERMS_PATH} target="_blank" rel="noopener noreferrer" className={link}>Termos de Uso</a> e a{' '}
            <a href={PRIVACY_PATH} target="_blank" rel="noopener noreferrer" className={link}>Política de Privacidade</a>.
        </p>
    );
}
