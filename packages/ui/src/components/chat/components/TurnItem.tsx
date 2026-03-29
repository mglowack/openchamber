import React from 'react';
import { RiArrowUpLine, RiArrowDownLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

import type { ChatMessageEntry, Turn } from '../lib/turns/types';
import TurnAssistantBlock from './TurnAssistantBlock';

interface TurnItemProps {
    turn: Turn;
    stickyUserHeader?: boolean;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
    turnIndex?: number;
    totalTurns?: number;
    onNavigateTurn?: (offset: number) => void;
    turnNavigation?: boolean;
    isMobile?: boolean;
}

const TurnItem: React.FC<TurnItemProps> = ({ turn, stickyUserHeader = true, renderMessage, turnIndex, totalTurns, onNavigateTurn, turnNavigation, isMobile }) => {
    const showNav = turnNavigation && stickyUserHeader && onNavigateTurn && totalTurns != null && totalTurns > 1 && turnIndex != null;

    return (
        <section
            className="relative w-full"
            id={`turn-${turn.turnId}`}
            data-turn-id={turn.turnId}
            data-scroll-spy-id={turn.turnId}
        >
            {stickyUserHeader ? (
                <div className={`sticky top-0 z-20 relative bg-[var(--surface-background)] [overflow-anchor:none]${showNav ? ' group/turn-header' : ''}`}>
                    <div className={`relative z-10${showNav ? ' flex items-start' : ''}`}>
                        {showNav && (
                            <div className={cn(
                                "h-[4.75rem] w-16 shrink-0 flex flex-col items-center justify-center pl-1 transition-opacity duration-150",
                                isMobile
                                    ? "opacity-100 pointer-events-auto"
                                    : "opacity-0 pointer-events-none group-hover/turn-header:opacity-100 group-hover/turn-header:pointer-events-auto"
                            )}>
                                <div className="flex items-center gap-1">
                                    <Tooltip delayDuration={1000}>
                                        <TooltipTrigger asChild>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="icon"
                                                disabled={turnIndex === 0}
                                                className="h-7 w-7 rounded-full p-0 shadow-none bg-[var(--surface-background)]/95 text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-30 disabled:pointer-events-none"
                                                aria-label="Previous turn"
                                                onPointerDown={(event) => event.stopPropagation()}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    onNavigateTurn(-1);
                                                }}
                                            >
                                                <RiArrowUpLine className="h-3.5 w-3.5" />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent sideOffset={6}>Previous turn</TooltipContent>
                                    </Tooltip>
                                    <Tooltip delayDuration={1000}>
                                        <TooltipTrigger asChild>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="icon"
                                                disabled={turnIndex === totalTurns - 1}
                                                className="h-7 w-7 rounded-full p-0 shadow-none bg-[var(--surface-background)]/95 text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-30 disabled:pointer-events-none"
                                                aria-label="Next turn"
                                                onPointerDown={(event) => event.stopPropagation()}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    onNavigateTurn(1);
                                                }}
                                            >
                                                <RiArrowDownLine className="h-3.5 w-3.5" />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent sideOffset={6}>Next turn</TooltipContent>
                                    </Tooltip>
                                </div>
                                <span className="text-xs text-muted-foreground tabular-nums select-none mt-0.5">{turnIndex + 1}/{totalTurns}</span>
                            </div>
                        )}
                        <div className={showNav ? "min-w-0 flex-1" : undefined}>
                            {renderMessage(turn.userMessage)}
                        </div>
                    </div>
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 top-full z-0 h-4 bg-gradient-to-b from-[var(--surface-background)] to-transparent sm:h-8"
                    />
                </div>
            ) : (
                renderMessage(turn.userMessage)
            )}

            <TurnAssistantBlock assistantMessages={turn.assistantMessages} renderMessage={renderMessage} />
        </section>
    );
};

export default React.memo(TurnItem);
