import { useMessageStore } from '@/stores/messageStore';
import { useSessionStore } from '@/stores/useSessionStore';

/**
 * Returns true if the current session has at least one completed
 * assistant message produced by the plan agent (mode === 'plan').
 *
 * Reactive: re-renders automatically when messages change,
 * so the build button enables as soon as a plan response arrives.
 */
export function useSessionHasPlan(): boolean {
    const sessionId = useSessionStore((s) => s.currentSessionId);
    return useMessageStore((state) => {
        if (!sessionId) return false;
        const msgs = state.messages.get(sessionId);
        if (!msgs) return false;
        return msgs.some(
            (m) => m.info?.role === 'assistant' && m.info?.mode === 'plan',
        );
    });
}
