import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import { createScrollSpy } from '@/components/chat/lib/scroll/scrollSpy';
import {
    isNearBottom,
    normalizeWheelDelta,
    shouldPauseAutoScrollOnWheel,
} from '@/components/chat/lib/scroll/scrollIntent';

import { useScrollEngine } from './useScrollEngine';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

export type ContentChangeReason = 'text' | 'structural' | 'permission';

interface ChatMessageRecord {
    info: Record<string, unknown>;
    parts: Part[];
}

interface SessionMemoryState {
    viewportAnchor: number;
    isStreaming: boolean;
    lastAccessedAt: number;
    backgroundMessageCount: number;
    totalAvailableMessages?: number;
    hasMoreAbove?: boolean;
    streamStartTime?: number;
    isZombie?: boolean;
}

interface UseChatScrollManagerOptions {
    currentSessionId: string | null;
    sessionMessages: ChatMessageRecord[];
    sessionPermissions: unknown[];
    streamingMessageId: string | null;
    sessionMemoryState: Map<string, SessionMemoryState>;
    updateViewportAnchor: (sessionId: string, anchor: number) => void;
    isSyncing: boolean;
    isMobile: boolean;
    chatRenderMode?: 'sorted' | 'live';
    messageStreamStates: Map<string, unknown>;
    onActiveTurnChange?: (turnId: string | null) => void;
}

export interface AnimationHandlers {
    onChunk: () => void;
    onComplete: () => void;
    onStreamingCandidate?: () => void;
    onAnimationStart?: () => void;
    onReservationCancelled?: () => void;
    onReasoningBlock?: () => void;
    onAnimatedHeightChange?: (height: number) => void;
}

interface UseChatScrollManagerResult {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    handleMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    showScrollButton: boolean;
    showScrollUpButton: boolean;
    scrollToBottom: (options?: { instant?: boolean; force?: boolean }) => void;
    scrollToCurrentTurnTop: () => void;
    scrollToPosition: (position: number, options?: { instant?: boolean }) => void;
    releasePinnedScroll: () => void;
    prepareForNavigation: () => void;
    isPinned: boolean;
    isOverflowing: boolean;
    isProgrammaticFollowActive: boolean;
}

const PROGRAMMATIC_SCROLL_SUPPRESS_MS = 200;
const DIRECT_SCROLL_INTENT_WINDOW_MS = 250;
// Threshold for re-pinning: 10% of container height (matches bottom spacer)
const PIN_THRESHOLD_RATIO = 0.10;
const VIEWPORT_ANCHOR_MIN_UPDATE_MS = 150;
// How long the scroll-up button stays visible after the user stops scrolling
const SCROLL_UP_HIDE_DELAY_MS = 1000;

export const useChatScrollManager = ({
    currentSessionId,
    sessionMessages,
    streamingMessageId,
    updateViewportAnchor,
    isSyncing,
    isMobile,
    onActiveTurnChange,
}: UseChatScrollManagerOptions): UseChatScrollManagerResult => {
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const scrollEngine = useScrollEngine({ containerRef: scrollRef, isMobile });

    const getPinThreshold = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container || container.clientHeight <= 0) {
            return 0;
        }
        const raw = container.clientHeight * PIN_THRESHOLD_RATIO;
        return Math.max(24, Math.min(200, raw));
    }, []);

    const getAutoFollowThreshold = React.useCallback(() => {
        return getPinThreshold();
    }, [getPinThreshold]);

    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const [showScrollUpButton, setShowScrollUpButton] = React.useState(false);
    const [isPinned, setIsPinned] = React.useState(true);
    const [isOverflowing, setIsOverflowing] = React.useState(false);

    const lastSessionIdRef = React.useRef<string | null>(null);
    const suppressUserScrollUntilRef = React.useRef<number>(0);
    const lastDirectScrollIntentAtRef = React.useRef<number>(0);
    const isPinnedRef = React.useRef(true);
    const lastScrollTopRef = React.useRef<number>(0);
    const touchLastYRef = React.useRef<number | null>(null);
    const pinnedSyncRafRef = React.useRef<number | null>(null);
    const viewportAnchorTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingViewportAnchorRef = React.useRef<{ sessionId: string; anchor: number } | null>(null);
    const lastViewportAnchorRef = React.useRef<{ sessionId: string; anchor: number } | null>(null);
    const lastViewportAnchorWriteAtRef = React.useRef<number>(0);
    const scrollUpHideTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const isNavigatingRef = React.useRef(false);

    const markProgrammaticScroll = React.useCallback(() => {
        suppressUserScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_SUPPRESS_MS;
    }, []);

    const getDistanceFromBottom = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) return 0;
        return container.scrollHeight - container.scrollTop - container.clientHeight;
    }, []);

    const updatePinnedState = React.useCallback((newPinned: boolean) => {
        if (isPinnedRef.current !== newPinned) {
            isPinnedRef.current = newPinned;
            setIsPinned(newPinned);
        }
    }, []);

    const scrollToBottomInternal = React.useCallback((options?: { instant?: boolean; followBottom?: boolean }) => {
        const container = scrollRef.current;
        if (!container) return;

        const bottom = container.scrollHeight - container.clientHeight;
        markProgrammaticScroll();
        scrollEngine.scrollToPosition(Math.max(0, bottom), options);
    }, [markProgrammaticScroll, scrollEngine]);

    const scrollPinnedToBottom = React.useCallback(() => {
        if (streamingMessageId) {
            scrollToBottomInternal({ followBottom: true });
            return;
        }

        scrollToBottomInternal({ instant: true });
    }, [scrollToBottomInternal, streamingMessageId]);

    const updateScrollButtonVisibility = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) {
            setShowScrollButton(false);
            setIsOverflowing(false);
            return;
        }

        const hasScrollableContent = container.scrollHeight > container.clientHeight;
        setIsOverflowing(hasScrollableContent);
        if (!hasScrollableContent) {
            setShowScrollButton(false);
            return;
        }

        // Show scroll button when scrolled above the 10vh threshold
        const distanceFromBottom = getDistanceFromBottom();
        setShowScrollButton(!isNearBottom(distanceFromBottom, getPinThreshold()));
    }, [getDistanceFromBottom, getPinThreshold]);

    const syncPinnedStateAndIndicators = React.useCallback(() => {
        pinnedSyncRafRef.current = null;
        updateScrollButtonVisibility();
        if (!isPinnedRef.current) {
            return;
        }

        const distanceFromBottom = getDistanceFromBottom();
        if (distanceFromBottom > getAutoFollowThreshold()) {
            scrollPinnedToBottom();
        }
    }, [getAutoFollowThreshold, getDistanceFromBottom, scrollPinnedToBottom, updateScrollButtonVisibility]);

    const schedulePinnedStateAndIndicators = React.useCallback(() => {
        if (typeof window === 'undefined') {
            syncPinnedStateAndIndicators();
            return;
        }
        if (pinnedSyncRafRef.current !== null) {
            return;
        }
        pinnedSyncRafRef.current = window.requestAnimationFrame(() => {
            syncPinnedStateAndIndicators();
        });
    }, [syncPinnedStateAndIndicators]);

    const flushViewportAnchor = React.useCallback(() => {
        if (viewportAnchorTimerRef.current !== null) {
            clearTimeout(viewportAnchorTimerRef.current);
            viewportAnchorTimerRef.current = null;
        }

        const pending = pendingViewportAnchorRef.current;
        if (!pending) {
            return;
        }

        const lastPersisted = lastViewportAnchorRef.current;
        if (lastPersisted && lastPersisted.sessionId === pending.sessionId && lastPersisted.anchor === pending.anchor) {
            pendingViewportAnchorRef.current = null;
            return;
        }

        updateViewportAnchor(pending.sessionId, pending.anchor);
        lastViewportAnchorRef.current = pending;
        pendingViewportAnchorRef.current = null;
        lastViewportAnchorWriteAtRef.current = Date.now();
    }, [updateViewportAnchor]);

    const queueViewportAnchor = React.useCallback((sessionId: string, anchor: number) => {
        const lastPersisted = lastViewportAnchorRef.current;
        if (lastPersisted && lastPersisted.sessionId === sessionId && lastPersisted.anchor === anchor) {
            return;
        }

        pendingViewportAnchorRef.current = { sessionId, anchor };
        const now = Date.now();
        const elapsed = now - lastViewportAnchorWriteAtRef.current;
        if (elapsed >= VIEWPORT_ANCHOR_MIN_UPDATE_MS) {
            flushViewportAnchor();
            return;
        }

        if (viewportAnchorTimerRef.current !== null) {
            return;
        }

        viewportAnchorTimerRef.current = setTimeout(() => {
            viewportAnchorTimerRef.current = null;
            flushViewportAnchor();
        }, VIEWPORT_ANCHOR_MIN_UPDATE_MS - elapsed);
    }, [flushViewportAnchor]);

    const scrollToPosition = React.useCallback((position: number, options?: { instant?: boolean }) => {
        const container = scrollRef.current;
        if (!container) return;

        markProgrammaticScroll();
        scrollEngine.scrollToPosition(Math.max(0, position), options);
    }, [markProgrammaticScroll, scrollEngine]);

    const scrollToBottom = React.useCallback((options?: { instant?: boolean; force?: boolean }) => {
        const container = scrollRef.current;
        if (!container) return;

        // User wants to be at bottom — clear navigation flag and re-pin
        isNavigatingRef.current = false;
        updatePinnedState(true);

        scrollToBottomInternal(options);
        setShowScrollButton(false);
    }, [scrollToBottomInternal, updatePinnedState]);

    const releasePinnedScroll = React.useCallback(() => {
        scrollEngine.cancelFollow();
        updatePinnedState(false);
        schedulePinnedStateAndIndicators();
    }, [schedulePinnedStateAndIndicators, scrollEngine, updatePinnedState]);

    /** Prepare for intentional scroll navigation — cancel follow, unpin, suppress scroll handler.
     *  Unlike releasePinnedScroll, does NOT schedule re-evaluation, so it won't fight
     *  the subsequent scrollTo call. */
    const prepareForNavigation = React.useCallback(() => {
        scrollEngine.cancelFollow();
        updatePinnedState(false);
        isNavigatingRef.current = true;
    }, [scrollEngine, updatePinnedState]);

    /**
     * Find the "tracked turn" — the exchange (prompt + response) that is currently
     * relevant based on viewport position. This is the turn whose section is at
     * least partially visible at the bottom of the viewport.
     */
    const getTrackedTurn = React.useCallback((): HTMLElement | null => {
        const container = scrollRef.current;
        if (!container) return null;

        const turns = container.querySelectorAll<HTMLElement>('[data-turn-id]');
        if (turns.length === 0) return null;

        const containerRect = container.getBoundingClientRect();

        // Walk turns bottom-up: the tracked turn is the lowest one whose section
        // overlaps with the viewport (any part of the turn section is visible).
        for (let i = turns.length - 1; i >= 0; i--) {
            const turnRect = turns[i].getBoundingClientRect();
            if (turnRect.top < containerRect.bottom && turnRect.bottom > containerRect.top) {
                return turns[i];
            }
        }

        // All turns are above the viewport — take the last one
        return turns[turns.length - 1] ?? null;
    }, []);

    /**
     * Find the scroll target within a turn section.
     * Priority:
     *   1. [data-answer-text] exists → first .group/assistant-text inside it (text paragraph in finished answer)
     *      → fallback to [data-answer-text] itself if no text paragraph found
     *   2. No [data-answer-text] → LAST .group/assistant-text in assistant area (nearest text before a question)
     *   3. Nothing → null (no text content in this turn)
     */
    const findAnswerTarget = React.useCallback((turnSection: HTMLElement): HTMLElement | null => {
        // Primary: finished answer
        const answerTextEl = turnSection.querySelector<HTMLElement>('[data-answer-text]');
        if (answerTextEl) {
            const textParagraph = answerTextEl.querySelector<HTMLElement>('.group\\/assistant-text');
            return textParagraph ?? answerTextEl;
        }

        // Fallback: last text paragraph before a question — the nearest context text,
        // not early throwaway text from before tool calls
        const assistantArea = turnSection.querySelector<HTMLElement>(':scope > div:last-child');
        if (!assistantArea) return null;
        const allText = assistantArea.querySelectorAll<HTMLElement>('.group\\/assistant-text');
        return allText.length > 0 ? allText[allText.length - 1] : null;
    }, []);

    /**
     * Starting from the tracked turn, walk backward through turn sections to find
     * the nearest one with a text answer target.
     * Returns the turn element and the target element, or null if none found.
     */
    const findNearestAnswerTurn = React.useCallback((): { turn: HTMLElement; answerEl: HTMLElement } | null => {
        const container = scrollRef.current;
        const trackedTurn = getTrackedTurn();
        if (!container || !trackedTurn) return null;

        const turns = container.querySelectorAll<HTMLElement>('[data-turn-id]');
        const turnsArray = Array.from(turns);
        const trackedIndex = turnsArray.indexOf(trackedTurn);
        if (trackedIndex < 0) return null;

        // Walk backward from tracked turn to find the first with a text target
        for (let i = trackedIndex; i >= 0; i--) {
            const answerEl = findAnswerTarget(turnsArray[i]);
            if (answerEl) {
                return { turn: turnsArray[i], answerEl };
            }
        }
        return null;
    }, [findAnswerTarget, getTrackedTurn]);

    /**
     * Get the total height of the sticky header area (header + gradient shadow).
     * Uses offsetHeight for reliable measurement regardless of sticky scroll state.
     */
    const getStickyHeaderOffset = React.useCallback((turnSection: HTMLElement): number => {
        const stickyHeader = turnSection.querySelector<HTMLElement>(':scope > .sticky');
        if (!stickyHeader) return 0;

        let offset = stickyHeader.offsetHeight;
        const shadowEl = stickyHeader.querySelector<HTMLElement>('[aria-hidden="true"]');
        if (shadowEl) {
            offset += shadowEl.offsetHeight;
        }
        return offset;
    }, []);

    /**
     * Scroll to the nearest answer text, positioned right below the sticky header + shadow.
     * Also unpins from bottom so autoscroll doesn't fight the navigation.
     */
    const scrollToCurrentTurnTop = React.useCallback(() => {
        const container = scrollRef.current;
        const target = findNearestAnswerTurn();
        if (!container || !target) return;

        const containerRect = container.getBoundingClientRect();
        const headerOffset = getStickyHeaderOffset(target.turn);

        const elRect = target.answerEl.getBoundingClientRect();
        const targetScrollTop = elRect.top - containerRect.top + container.scrollTop - headerOffset;

        // Unpin so autoscroll doesn't fight this intentional navigation
        prepareForNavigation();
        scrollEngine.scrollToPosition(Math.max(0, targetScrollTop));
        setShowScrollUpButton(false);
    }, [findNearestAnswerTurn, getStickyHeaderOffset, prepareForNavigation, scrollEngine]);

    /**
     * Check whether the arrow-up button should be visible.
     * True when there is a nearest answer turn whose text target is above
     * the visible area (hidden behind or above the sticky header + shadow).
     */
    const isAboveCurrentTurnTop = React.useCallback((): boolean => {
        const container = scrollRef.current;
        const target = findNearestAnswerTurn();
        if (!container || !target) return false;

        const containerRect = container.getBoundingClientRect();
        const headerOffset = getStickyHeaderOffset(target.turn);
        const answerRect = target.answerEl.getBoundingClientRect();

        // Arrow shows when the answer's top is above the header bottom edge
        return answerRect.top < containerRect.top + headerOffset;
    }, [findNearestAnswerTurn, getStickyHeaderOffset]);

    /** Show the scroll-up button temporarily, then hide after idle delay. */
    const flashScrollUpButton = React.useCallback(() => {
        if (!isAboveCurrentTurnTop()) {
            setShowScrollUpButton(false);
            return;
        }
        setShowScrollUpButton(true);

        if (scrollUpHideTimerRef.current) clearTimeout(scrollUpHideTimerRef.current);
        scrollUpHideTimerRef.current = setTimeout(() => {
            setShowScrollUpButton(false);
        }, SCROLL_UP_HIDE_DELAY_MS);
    }, [isAboveCurrentTurnTop]);

    // Cleanup timer on unmount
    React.useEffect(() => {
        return () => {
            if (scrollUpHideTimerRef.current) clearTimeout(scrollUpHideTimerRef.current);
        };
    }, []);

    const handleScrollEvent = React.useCallback((event?: Event) => {
        const container = scrollRef.current;
        if (!container || !currentSessionId) {
            return;
        }

        const now = Date.now();
        const isProgrammatic = now < suppressUserScrollUntilRef.current;
        const hasDirectIntent = now - lastDirectScrollIntentAtRef.current <= DIRECT_SCROLL_INTENT_WINDOW_MS;

        scrollEngine.handleScroll();
        schedulePinnedStateAndIndicators();

        // Handle pin/unpin logic
        const currentScrollTop = container.scrollTop;
        const scrollingUp = currentScrollTop < lastScrollTopRef.current;

        // Unpin requires strict user intent check
        if (event?.isTrusted && !isProgrammatic && hasDirectIntent) {
            if (scrollingUp && isPinnedRef.current) {
                updatePinnedState(false);
            }
        }

        // Re-pin at bottom should always work (even momentum scroll),
        // but NOT during intentional navigation (lightbulb/arrow-up scroll)
        if (!isPinnedRef.current && !isNavigatingRef.current) {
            const distanceFromBottom = getDistanceFromBottom();
            if (distanceFromBottom <= getPinThreshold()) {
                updatePinnedState(true);
            }
        }

        lastScrollTopRef.current = currentScrollTop;

        // Show ephemeral scroll-up button on user-initiated scroll
        if (event?.isTrusted && hasDirectIntent) {
            flashScrollUpButton();
        }

        const { scrollTop, scrollHeight, clientHeight } = container;
        const position = (scrollTop + clientHeight / 2) / Math.max(scrollHeight, 1);
        const estimatedIndex = Math.floor(position * sessionMessages.length);
        queueViewportAnchor(currentSessionId, estimatedIndex);
    }, [
        currentSessionId,
        flashScrollUpButton,
        getDistanceFromBottom,
        getPinThreshold,
        queueViewportAnchor,
        schedulePinnedStateAndIndicators,
        scrollEngine,
        sessionMessages.length,
        updatePinnedState,
    ]);

    const handleWheelIntent = React.useCallback((event: WheelEvent) => {
        const container = scrollRef.current;
        if (!container) {
            return;
        }

        // User is actively scrolling — clear navigation flag so re-pin can work
        isNavigatingRef.current = false;

        const delta = normalizeWheelDelta({
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            rootHeight: container.clientHeight,
        });

        if (isPinnedRef.current && shouldPauseAutoScrollOnWheel({
            root: container,
            target: event.target,
            delta,
        })) {
            scrollEngine.cancelFollow();
            updatePinnedState(false);
        }
    }, [scrollEngine, updatePinnedState]);

    React.useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        const markDirectIntent = () => {
            lastDirectScrollIntentAtRef.current = Date.now();
        };

        const handleTouchStartIntent = (event: TouchEvent) => {
            markDirectIntent();
            const touch = event.touches.item(0);
            touchLastYRef.current = touch ? touch.clientY : null;
        };

        const handleTouchMoveIntent = (event: TouchEvent) => {
            markDirectIntent();

            // User is actively scrolling with finger — clear navigation flag so re-pin can work
            isNavigatingRef.current = false;

            const touch = event.touches.item(0);
            if (!touch) {
                touchLastYRef.current = null;
                return;
            }

            const previousY = touchLastYRef.current;
            touchLastYRef.current = touch.clientY;
            if (previousY === null || !isPinnedRef.current) {
                return;
            }

            const fingerDelta = touch.clientY - previousY;
            if (Math.abs(fingerDelta) < 2) {
                return;
            }

            const syntheticWheelDelta = -fingerDelta;
            if (syntheticWheelDelta >= 0) {
                return;
            }

            if (shouldPauseAutoScrollOnWheel({
                root: container,
                target: event.target,
                delta: syntheticWheelDelta,
            })) {
                scrollEngine.cancelFollow();
                updatePinnedState(false);
            }
        };

        const handleTouchEndIntent = () => {
            touchLastYRef.current = null;
        };

        container.addEventListener('scroll', handleScrollEvent as EventListener, { passive: true });
        container.addEventListener('touchstart', handleTouchStartIntent as EventListener, { passive: true });
        container.addEventListener('touchmove', handleTouchMoveIntent as EventListener, { passive: true });
        container.addEventListener('touchend', handleTouchEndIntent as EventListener, { passive: true });
        container.addEventListener('touchcancel', handleTouchEndIntent as EventListener, { passive: true });
        container.addEventListener('wheel', handleWheelIntent as EventListener, { passive: true });
        container.addEventListener('wheel', markDirectIntent as EventListener, { passive: true });

        return () => {
            container.removeEventListener('scroll', handleScrollEvent as EventListener);
            container.removeEventListener('touchstart', handleTouchStartIntent as EventListener);
            container.removeEventListener('touchmove', handleTouchMoveIntent as EventListener);
            container.removeEventListener('touchend', handleTouchEndIntent as EventListener);
            container.removeEventListener('touchcancel', handleTouchEndIntent as EventListener);
            container.removeEventListener('wheel', handleWheelIntent as EventListener);
            container.removeEventListener('wheel', markDirectIntent as EventListener);
        };
    }, [handleScrollEvent, handleWheelIntent, scrollEngine, updatePinnedState]);

    // Session switch - always start pinned at bottom
    useIsomorphicLayoutEffect(() => {
        if (!currentSessionId || currentSessionId === lastSessionIdRef.current) {
            return;
        }

        lastSessionIdRef.current = currentSessionId;
        isNavigatingRef.current = false;
        MessageFreshnessDetector.getInstance().recordSessionStart(currentSessionId);
        flushViewportAnchor();
        pendingViewportAnchorRef.current = null;

        // Always start pinned at bottom on session switch
        updatePinnedState(true);
        setShowScrollButton(false);

        const container = scrollRef.current;
        if (container) {
            markProgrammaticScroll();
            scrollToBottomInternal({ instant: true });
        }
    }, [currentSessionId, flushViewportAnchor, markProgrammaticScroll, scrollToBottomInternal, updatePinnedState]);

    // Maintain pin-to-bottom when content changes
    React.useEffect(() => {
        if (isSyncing) {
            return;
        }
        schedulePinnedStateAndIndicators();
    }, [isSyncing, schedulePinnedStateAndIndicators, sessionMessages.length]);

    // Use ResizeObserver to detect content changes and maintain pin
    React.useEffect(() => {
        const container = scrollRef.current;
        if (!container || typeof ResizeObserver === 'undefined') return;

        const observer = new ResizeObserver(() => {
            schedulePinnedStateAndIndicators();
        });

        observer.observe(container);

        // Also observe children for content changes
        const childObserver = new MutationObserver(() => {
            schedulePinnedStateAndIndicators();
        });

        childObserver.observe(container, { childList: true, subtree: true });

        return () => {
            observer.disconnect();
            childObserver.disconnect();
        };
    }, [schedulePinnedStateAndIndicators]);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            schedulePinnedStateAndIndicators();
            return;
        }

        const rafId = window.requestAnimationFrame(() => {
            schedulePinnedStateAndIndicators();
        });

        return () => {
            window.cancelAnimationFrame(rafId);
        };
    }, [currentSessionId, schedulePinnedStateAndIndicators, sessionMessages.length]);

    const animationHandlersRef = React.useRef<Map<string, AnimationHandlers>>(new Map());

    const handleMessageContentChange = React.useCallback(() => {
        schedulePinnedStateAndIndicators();
    }, [schedulePinnedStateAndIndicators]);

    const getAnimationHandlers = React.useCallback((messageId: string): AnimationHandlers => {
        const existing = animationHandlersRef.current.get(messageId);
        if (existing) {
            return existing;
        }

        const handlers: AnimationHandlers = {
            onChunk: () => {
                schedulePinnedStateAndIndicators();
            },
            onComplete: () => {
                schedulePinnedStateAndIndicators();
            },
            onStreamingCandidate: () => {},
            onAnimationStart: () => {},
            onAnimatedHeightChange: () => {
                schedulePinnedStateAndIndicators();
            },
            onReservationCancelled: () => {},
            onReasoningBlock: () => {},
        };

        animationHandlersRef.current.set(messageId, handlers);
        return handlers;
    }, [schedulePinnedStateAndIndicators]);

    React.useEffect(() => {
        return () => {
            if (pinnedSyncRafRef.current !== null && typeof window !== 'undefined') {
                window.cancelAnimationFrame(pinnedSyncRafRef.current);
                pinnedSyncRafRef.current = null;
            }

            flushViewportAnchor();
            if (viewportAnchorTimerRef.current !== null) {
                clearTimeout(viewportAnchorTimerRef.current);
                viewportAnchorTimerRef.current = null;
            }
        };
    }, [flushViewportAnchor]);

    React.useEffect(() => {
        if (!onActiveTurnChange) {
            return;
        }

        const container = scrollRef.current;
        if (!container) {
            onActiveTurnChange(null);
            return;
        }

        const spy = createScrollSpy({
            onActive: (turnId) => {
                onActiveTurnChange(turnId);
            },
        });

        spy.setContainer(container);

        const elementByTurnId = new Map<string, HTMLElement>();

        const registerTurnNode = (node: HTMLElement): boolean => {
            const turnId = node.dataset.turnId;
            if (!turnId) {
                return false;
            }
            elementByTurnId.set(turnId, node);
            spy.register(node, turnId);
            return true;
        };

        const unregisterTurnNode = (node: HTMLElement): boolean => {
            const turnId = node.dataset.turnId;
            if (!turnId) {
                return false;
            }
            if (elementByTurnId.get(turnId) !== node) {
                return false;
            }
            elementByTurnId.delete(turnId);
            spy.unregister(turnId);
            return true;
        };

        const collectTurnNodes = (node: Node): HTMLElement[] => {
            if (!(node instanceof HTMLElement)) {
                return [];
            }
            const collected: HTMLElement[] = [];
            if (node.matches('[data-turn-id]')) {
                collected.push(node);
            }
            node.querySelectorAll<HTMLElement>('[data-turn-id]').forEach((turnNode) => {
                collected.push(turnNode);
            });
            return collected;
        };

        container.querySelectorAll<HTMLElement>('[data-turn-id]').forEach((node) => {
            registerTurnNode(node);
        });
        spy.markDirty();

        const mutationObserver = new MutationObserver((records) => {
            let changed = false;

            records.forEach((record) => {
                record.removedNodes.forEach((node) => {
                    collectTurnNodes(node).forEach((turnNode) => {
                        if (unregisterTurnNode(turnNode)) {
                            changed = true;
                        }
                    });
                });

                record.addedNodes.forEach((node) => {
                    collectTurnNodes(node).forEach((turnNode) => {
                        if (registerTurnNode(turnNode)) {
                            changed = true;
                        }
                    });
                });
            });

            if (changed) {
                spy.markDirty();
            }
        });
        mutationObserver.observe(container, { subtree: true, childList: true });

        const handleScroll = () => {
            spy.onScroll();
        };
        container.addEventListener('scroll', handleScroll, { passive: true });

        return () => {
            container.removeEventListener('scroll', handleScroll);
            mutationObserver.disconnect();
            spy.destroy();
            onActiveTurnChange(null);
        };
    }, [currentSessionId, onActiveTurnChange, scrollRef, sessionMessages.length]);

    return {
        scrollRef,
        handleMessageContentChange,
        getAnimationHandlers,
        showScrollButton,
        showScrollUpButton,
        scrollToBottom,
        scrollToCurrentTurnTop,
        scrollToPosition,
        releasePinnedScroll,
        prepareForNavigation,
        isPinned,
        isOverflowing,
        isProgrammaticFollowActive: scrollEngine.isFollowingBottom,
    };
};
