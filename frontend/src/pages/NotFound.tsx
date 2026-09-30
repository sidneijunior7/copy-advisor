import { Link } from 'react-router-dom';

export default function NotFound() {
    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-8">
            <div className="text-center">
                <p className="font-mono text-6xl font-bold text-gradient">404</p>
                <h1 className="mt-4 text-xl font-semibold">Página não encontrada</h1>
                <p className="mt-2 text-muted-foreground">O endereço acessado não existe ou foi movido.</p>
                <Link to="/dashboard" className="mt-6 inline-block font-medium text-primary underline-offset-4 hover:underline">
                    Voltar ao início
                </Link>
            </div>
        </div>
    );
}
