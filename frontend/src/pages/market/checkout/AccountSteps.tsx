import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Eye, EyeOff, Lock, Mail, User as UserIcon } from 'lucide-react';
import TermsNotice from '../../../components/TermsNotice';
import { Button } from '../../../components/ui/Button';
import { Field, Input } from '../../../components/ui/Field';
import { formatCpf } from '../../../lib/cpf';
import { StepHeader } from './parts';

export const PASSWORD_MIN = 8;
export const CPF_REASON = 'Usamos para identificar o titular da assinatura. Não compartilhamos com o gestor.';

const linkClass = 'font-medium text-primary underline-offset-4 hover:underline';

type FieldError = { field: string; message: string } | null;

// A CPF that already has an account: the two ways forward, instead of a dead end on the last screen
export type CpfTaken = { onOtherEmail: () => void };

function Panel({ children }: { children: ReactNode }) {
    return <section className="panel space-y-6 p-5 sm:p-8">{children}</section>;
}

// Which email the account is for, with the way back to change it, on every sign-up screen
function ForEmail({ email, onOtherEmail, children }: { email: string; onOtherEmail: () => void; children?: ReactNode }) {
    return (
        <>
            {children}Para <strong className="text-foreground">{email}</strong>.{' '}
            <button type="button" onClick={onOtherEmail} className={`min-h-9 ${linkClass}`}>Usar outro email</button>
        </>
    );
}

function PasswordInput({ id, value, onChange, autoComplete, autoFocus }: {
    id: string; value: string; onChange: (v: string) => void; autoComplete: string; autoFocus?: boolean;
}) {
    const [show, setShow] = useState(false);
    return (
        <div className="relative">
            <Input id={id} type={show ? 'text' : 'password'} autoComplete={autoComplete} value={value}
                onChange={e => onChange(e.target.value)} icon={<Lock />} className="h-12 pr-12 text-base" autoFocus={autoFocus} />
            <button type="button" onClick={() => setShow(v => !v)} aria-label={show ? 'Esconder a senha' : 'Mostrar a senha'}
                className="absolute right-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center text-muted-foreground hover:text-foreground [&_svg]:size-4">
                {show ? <EyeOff /> : <Eye />}
            </button>
        </div>
    );
}

function CpfTakenBox({ taken }: { taken: CpfTaken }) {
    return (
        <div role="alert" className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            <p className="font-medium text-destructive">Este CPF já tem uma conta.</p>
            <div className="flex flex-col gap-2 sm:flex-row">
                <Button type="button" variant="outline" className="flex-1" onClick={taken.onOtherEmail}>Entrar com outro email</Button>
                <Link to="/recuperar-senha" className="flex-1"><Button type="button" variant="ghost" className="w-full">Recuperar acesso</Button></Link>
            </div>
        </div>
    );
}

// The email is asked right after the simulator: the card shows what will be sent to it, so the request has a reason
export function EmailStep({ email, onEmail, error, busy, promo, preview, onSubmit }: {
    email: string; onEmail: (v: string) => void; error: string | null; busy: boolean; promo: boolean; preview?: ReactNode;
    onSubmit: (e: FormEvent) => void;
}) {
    return (
        <Panel>
            <StepHeader title={promo ? 'Qual é o seu email?' : 'Para qual email enviamos a sua simulação?'}>
                {promo
                    ? 'Se você já tem conta no Trademetric Mirror, a gente reconhece.'
                    : 'Se você parar no meio, ela chega no seu email. Se já tem conta no Mirror, a gente reconhece.'}
            </StepHeader>
            {!promo && preview && (
                <div className="mx-auto max-w-md rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
                    <p className="text-xs font-medium text-muted-foreground">Sua simulação</p>
                    {preview}
                </div>
            )}
            <form onSubmit={onSubmit} className="mx-auto max-w-md space-y-4" noValidate>
                <Field label="Email" htmlFor="checkout-email" error={error ?? undefined}>
                    <Input id="checkout-email" type="email" autoComplete="email" inputMode="email" value={email}
                        onChange={e => onEmail(e.target.value)} placeholder="voce@exemplo.com" icon={<Mail />} className="h-12 text-base" autoFocus />
                </Field>
                <Button type="submit" size="lg" className="w-full" loading={busy}>Continuar {!busy && <ArrowRight />}</Button>
                {!promo && <p className="text-center text-xs text-muted-foreground">No máximo 2 emails, e todos trazem um link para parar.</p>}
            </form>
        </Panel>
    );
}

export function LoginStep({ email, password, onPassword, error, busy, onOtherEmail, onSubmit }: {
    email: string; password: string; onPassword: (v: string) => void; error: string | null; busy: boolean;
    onOtherEmail: () => void; onSubmit: (e: FormEvent) => void;
}) {
    return (
        <Panel>
            <StepHeader title="Que bom te ver de novo!">
                <ForEmail email={email} onOtherEmail={onOtherEmail}>Você já tem conta. </ForEmail>
            </StepHeader>
            <form onSubmit={onSubmit} className="mx-auto max-w-md space-y-4" noValidate>
                <Field label="Sua senha no Mirror" htmlFor="checkout-login-password" error={error ?? undefined}>
                    <PasswordInput id="checkout-login-password" value={password} onChange={onPassword} autoComplete="current-password" autoFocus />
                </Field>
                <Button type="submit" size="lg" className="w-full" loading={busy}>Entrar e continuar {!busy && <ArrowRight />}</Button>
                <p className="text-center text-xs text-muted-foreground">
                    Esqueceu a senha? <Link to="/recuperar-senha" className={linkClass}>Recuperar acesso por email</Link>
                </p>
            </form>
        </Panel>
    );
}

// A phone: the name and the password on one screen, the CPF on the next. Two screens for the sign-up, not three
export function NameStep({ email, name, onName, password, onPassword, error, onOtherEmail, onSubmit }: {
    email: string; name: string; onName: (v: string) => void; password: string; onPassword: (v: string) => void;
    error: FieldError; onOtherEmail: () => void; onSubmit: (e: FormEvent) => void;
}) {
    const of = (field: string) => (error?.field === field ? error.message : undefined);
    return (
        <Panel>
            <StepHeader title="Crie sua conta">
                <ForEmail email={email} onOtherEmail={onOtherEmail} />
            </StepHeader>
            <form onSubmit={onSubmit} className="mx-auto max-w-md space-y-4" noValidate>
                <Field label="Seu nome completo" htmlFor="checkout-name" error={of('name')}>
                    <Input id="checkout-name" autoComplete="name" value={name} onChange={e => onName(e.target.value)}
                        placeholder="Ex.: João Silva" icon={<UserIcon />} className="h-12 text-base" autoFocus />
                </Field>
                <Field label="Crie uma senha" htmlFor="checkout-register-password" hint={`Mínimo de ${PASSWORD_MIN} caracteres.`} error={of('password')}>
                    <PasswordInput id="checkout-register-password" value={password} onChange={onPassword} autoComplete="new-password" />
                </Field>
                <Button type="submit" size="lg" className="w-full">Continuar <ArrowRight /></Button>
            </form>
        </Panel>
    );
}

export function CpfStep({ cpf, onCpf, error, taken, busy, onSubmit }: {
    cpf: string; onCpf: (v: string) => void; error: string | null; taken: CpfTaken | null; busy: boolean; onSubmit: (e: FormEvent) => void;
}) {
    return (
        <Panel>
            <StepHeader title="Por último, o seu CPF">{CPF_REASON}</StepHeader>
            <form onSubmit={onSubmit} className="mx-auto max-w-md space-y-4" noValidate>
                <Field label="CPF" htmlFor="checkout-cpf" error={taken ? undefined : error ?? undefined}>
                    <Input id="checkout-cpf" inputMode="numeric" autoComplete="off" value={cpf} onChange={e => onCpf(formatCpf(e.target.value))}
                        placeholder="000.000.000-00" className="h-12 font-mono text-base tracking-wider" autoFocus />
                </Field>
                {taken && <CpfTakenBox taken={taken} />}
                <Button type="submit" size="lg" className="w-full" loading={busy}>Criar conta e revisar {!busy && <ArrowRight />}</Button>
                <TermsNotice />
            </form>
        </Panel>
    );
}

// A wide screen asks the three at once: fewer screens between the simulator and the payment
export function DetailsStep({ email, name, onName, password, onPassword, cpf, onCpf, error, taken, busy, onOtherEmail, onSubmit }: {
    email: string; name: string; onName: (v: string) => void; password: string; onPassword: (v: string) => void;
    cpf: string; onCpf: (v: string) => void; error: FieldError; taken: CpfTaken | null; busy: boolean;
    onOtherEmail: () => void; onSubmit: (e: FormEvent) => void;
}) {
    const of = (field: string) => (error?.field === field ? error.message : undefined);
    return (
        <Panel>
            <StepHeader title="Crie sua conta">
                <ForEmail email={email} onOtherEmail={onOtherEmail} />
            </StepHeader>
            <form onSubmit={onSubmit} className="mx-auto max-w-md space-y-4" noValidate>
                <Field label="Seu nome completo" htmlFor="checkout-name" error={of('name')}>
                    <Input id="checkout-name" autoComplete="name" value={name} onChange={e => onName(e.target.value)}
                        placeholder="Ex.: João Silva" icon={<UserIcon />} className="h-12 text-base" autoFocus />
                </Field>
                <Field label="Crie uma senha" htmlFor="checkout-register-password" hint={`Mínimo de ${PASSWORD_MIN} caracteres.`} error={of('password')}>
                    <PasswordInput id="checkout-register-password" value={password} onChange={onPassword} autoComplete="new-password" />
                </Field>
                <Field label="CPF" htmlFor="checkout-cpf" hint={CPF_REASON} error={taken ? undefined : of('cpf')}>
                    <Input id="checkout-cpf" inputMode="numeric" autoComplete="off" value={cpf} onChange={e => onCpf(formatCpf(e.target.value))}
                        placeholder="000.000.000-00" className="h-12 font-mono text-base tracking-wider" />
                </Field>
                {taken && <CpfTakenBox taken={taken} />}
                {error?.field === 'form' && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
                <Button type="submit" size="lg" className="w-full" loading={busy}>Criar conta e revisar {!busy && <ArrowRight />}</Button>
                <TermsNotice />
            </form>
        </Panel>
    );
}
