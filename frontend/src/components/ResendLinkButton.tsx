import { useState } from 'react';
import { toast } from 'sonner';
import api from '../api';
import { Button } from './ui/Button';
import { apiError } from '../lib/utils';

// Sends the confirmation link again. The API answers once the email server took it (a few seconds), so the
// button waits and a refusal shows here instead of a false "sent"
export default function ResendLinkButton() {
    const [sending, setSending] = useState(false);
    const resend = async () => {
        setSending(true);
        try {
            await api.post('/email/resend');
            toast.success('Link enviado: confira sua caixa de entrada');
        } catch (e) {
            toast.error(apiError(e, 'Não foi possível enviar o link.'));
        } finally {
            setSending(false);
        }
    };
    return <Button size="sm" variant="outline" loading={sending} onClick={resend}>{sending ? 'Enviando...' : 'Reenviar link'}</Button>;
}
