
import { type ReactNode } from 'react';
import { motion } from 'framer-motion';

interface CardProps {
    children: ReactNode;
    title?: string;
    className?: string;
}

export default function Card({ children, title, className = '' }: CardProps) {
    return (
        <motion.div
            className={`bg-background border border-border/50 p-6 rounded-xl shadow-lg hover:shadow-xl transition-shadow ${className}`}
        >
            {title && <h2 className="text-xl font-bold bg-gradient-to-r from-teal-400 to-emerald-400 bg-clip-text text-transparent mb-4">{title}</h2>}
            {children}
        </motion.div>
    );
}
