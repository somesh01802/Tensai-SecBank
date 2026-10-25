import { create } from "zustand"

/** A transaction attempt the customer can rate (set by the API client when a response carries attemptId). */
export interface FeedbackOffer {
  attemptId: string
  ok: boolean
  message?: string
}

interface FeedbackState {
  current: FeedbackOffer | null
  offer: (o: FeedbackOffer) => void
  close: () => void
}

export const useFeedbackStore = create<FeedbackState>((set) => ({
  current: null,
  offer: (current) => set({ current }),
  close: () => set({ current: null })
}))
