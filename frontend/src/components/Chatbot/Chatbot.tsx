import { useEffect, useRef, useState } from "react"
import { Bot, Loader2, MessageSquare, Send, Sparkles, X } from "lucide-react"

import { LogoMark } from "@/components/Logo"
import { chatbotApi, type ChatTurn } from "@/api/chatbot"
import { apiErrorMessage } from "@/api/client"
import { useAuthStore } from "@/stores/authStore"

const STORAGE_KEY = "tsb_chatbot_history_v1"

const STARTER_QUESTIONS = [
  "What's my current balance?",
  "Show my recent transactions",
  "What loans do I have?",
  "How many reward points?",
  "How do I download my statement?"
]

/**
 * Floating banking assistant. Renders a soft-glowing button pinned to the
 * bottom-right of every authenticated page. Clicking it opens a chat panel.
 * Persists history to localStorage so the conversation survives page navs.
 */
export function Chatbot() {
  const user = useAuthStore((s) => s.user)
  const token = useAuthStore((s) => s.token)
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<ChatTurn[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) return JSON.parse(raw)
    } catch { /* ignore */ }
    return []
  })
  const [pending, setPending] = useState(false)
  const [source, setSource] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Only mount when authenticated
  if (!token || !user) return null

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages)) } catch { /* ignore */ }
  }, [messages])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, open, pending])

  async function submit(text?: string) {
    const msg = (text ?? input).trim()
    if (!msg || pending) return
    setInput("")
    const nextHistory: ChatTurn[] = [...messages, { role: "user", content: msg }]
    setMessages(nextHistory)
    setPending(true)
    try {
      const res = await chatbotApi.send(msg, messages)
      setSource(res.source)
      setMessages([...nextHistory, { role: "assistant", content: res.reply }])
    } catch (err) {
      setMessages([
        ...nextHistory,
        { role: "assistant", content: apiErrorMessage(err, "Sorry, I couldn't answer that just now.") }
      ])
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close assistant" : "Open assistant"}
        className="fixed bottom-6 right-6 z-40 grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-2xl shadow-brand-600/40 transition hover:scale-105 focus:outline-none focus:ring-4 focus:ring-brand-500/30"
        style={{ animation: "tsb-chatbot-float 3.4s ease-in-out infinite" }}
      >
        {/* Soft outer glow ring */}
        <span
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{ boxShadow: "0 0 0 0 rgba(58,99,255,.55)", animation: "tsb-chatbot-pulse 2.4s ease-out infinite" }}
        />
        {open ? <X className="h-6 w-6" /> : <MessageSquare className="h-6 w-6" />}
      </button>

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-24 right-6 z-40 flex h-[min(600px,80vh)] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-slate-100 bg-gradient-to-br from-brand-50 to-white px-4 py-3 dark:border-slate-800 dark:from-brand-500/10 dark:to-transparent">
            <LogoMark size={30} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="flex items-center gap-1.5 text-sm font-bold text-slate-900 dark:text-slate-100">
                TSB Assistant
                <Sparkles className="h-3 w-3 text-brand-500" />
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">
                Your in-app banking helper
              </div>
            </div>
            <button onClick={() => setOpen(false)} className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages.length === 0 && (
              <div className="space-y-3">
                <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-900/50 dark:text-slate-300">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
                      <Bot className="h-3.5 w-3.5" />
                    </span>
                    <div>
                      Hi {user.name?.split(" ")[0] || "there"}! I'm the Tensai SecBank assistant.
                      I can answer questions about your own accounts, balances, loans, cards,
                      bills, transfers, and rewards. I won't ever share sensitive info like your MPIN,
                      CVV, or full card number.
                    </div>
                  </div>
                </div>
                <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                  Try asking
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {STARTER_QUESTIONS.map((q) => (
                    <button
                      key={q}
                      onClick={() => submit(q)}
                      className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:border-brand-300 hover:text-brand-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[85%] rounded-2xl bg-brand-600 px-3 py-2 text-sm text-white shadow-sm"
                      : "flex max-w-[85%] items-start gap-2 rounded-2xl bg-slate-50 px-3 py-2 text-sm text-slate-800 dark:bg-slate-900/50 dark:text-slate-100"
                  }
                >
                  {m.role === "assistant" && (
                    <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
                      <Bot className="h-3 w-3" />
                    </span>
                  )}
                  <div className="min-w-0 whitespace-pre-wrap break-words leading-relaxed">
                    {m.content}
                  </div>
                </div>
              </div>
            ))}
            {pending && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl bg-slate-50 px-3 py-2 text-sm text-slate-500 dark:bg-slate-900/50">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Thinking…
                </div>
              </div>
            )}
          </div>

          {/* Footer: source hint + clear + input */}
          <div className="border-t border-slate-100 dark:border-slate-800">
            {(source || messages.length > 0) && (
              <div className="flex items-center justify-between px-4 py-1.5 text-[10px] text-slate-400">
                <span>{source === "llm" ? "Powered by AI" : source === "rules" ? "Offline mode" : "Ready"}</span>
                {messages.length > 0 && (
                  <button
                    onClick={() => { setMessages([]); setSource(null) }}
                    className="hover:text-slate-700 dark:hover:text-slate-200"
                  >
                    Clear chat
                  </button>
                )}
              </div>
            )}
            <form
              onSubmit={(e) => { e.preventDefault(); submit() }}
              className="flex items-center gap-2 px-3 pb-3"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about your accounts, transfers, cards…"
                className="w-full rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
                disabled={pending}
              />
              <button
                type="submit"
                disabled={pending || !input.trim()}
                className="grid h-9 w-9 place-items-center rounded-full bg-brand-600 text-white shadow-md shadow-brand-600/30 transition hover:bg-brand-700 disabled:opacity-40"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Keyframes for float + pulse */}
      <style>{`
        @keyframes tsb-chatbot-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }
        @keyframes tsb-chatbot-pulse {
          0% { box-shadow: 0 0 0 0 rgba(58,99,255,.55); }
          70% { box-shadow: 0 0 0 18px rgba(58,99,255,0); }
          100% { box-shadow: 0 0 0 0 rgba(58,99,255,0); }
        }
      `}</style>
    </>
  )
}
