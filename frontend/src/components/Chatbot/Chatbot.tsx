import { useEffect, useRef, useState } from "react"
import { Bot, Loader2, Send, Sparkles, X } from "lucide-react"

import { chatbotApi, type ChatTurn } from "@/api/chatbot"
import { apiErrorMessage } from "@/api/client"
import { useAuthStore } from "@/stores/authStore"
import { NexusIcon } from "./NexusIcon"

const STORAGE_KEY = "tsb_nexus_history_v1"
const WELCOME_KEY = "tsb_nexus_welcomed_v2"

const STARTER_QUESTIONS = [
  "How do I apply for a credit card?",
  "How can I apply for a loan?",
  "How do I transfer money?",
  "How do I add a payee?",
  "What's my current balance?"
]

/**
 * Nexus — Tensai SecBank's floating AI assistant.
 *
 * Renders a soft-glowing button pinned to the bottom-right of every
 * authenticated page. Clicking it opens the chat panel. Shows a welcome
 * dialog the first time an authenticated user sees the app, gated by a
 * localStorage flag.
 */
export function Chatbot() {
  const user = useAuthStore((s) => s.user)
  const token = useAuthStore((s) => s.token)
  const [open, setOpen] = useState(false)
  const [showWelcome, setShowWelcome] = useState(false)
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

  // First-visit welcome dialog — delayed so the app has settled.
  useEffect(() => {
    if (!token || !user) return
    let seen = false
    try { seen = Boolean(localStorage.getItem(WELCOME_KEY)) } catch { /* ignore */ }
    if (seen) return
    const t = setTimeout(() => setShowWelcome(true), 1200)
    return () => clearTimeout(t)
  }, [token, user])

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages)) } catch { /* ignore */ }
  }, [messages])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, open, pending])

  if (!token || !user) return null

  function dismissWelcome() {
    setShowWelcome(false)
    try { localStorage.setItem(WELCOME_KEY, "1") } catch { /* ignore */ }
  }

  function openFromWelcome() {
    dismissWelcome()
    setOpen(true)
  }

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
        onClick={() => { setOpen((v) => !v); dismissWelcome() }}
        aria-label={open ? "Close Nexus" : "Open Nexus"}
        className="fixed bottom-6 right-6 z-40 grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-[#0e1a3c] via-[#2b3fc8] to-[#7c3aed] text-white shadow-2xl shadow-brand-600/40 transition hover:scale-105 focus:outline-none focus:ring-4 focus:ring-brand-500/30"
        style={{ animation: "nexus-float 3.4s ease-in-out infinite" }}
      >
        <span
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            boxShadow: "0 0 0 0 rgba(124,58,237,.55)",
            animation: "nexus-pulse 2.4s ease-out infinite"
          }}
        />
        {open ? <X className="h-6 w-6" /> : <NexusIcon size={30} animated />}
      </button>

      {/* Welcome dialog (first-visit only) */}
      {showWelcome && !open && (
        <div
          className="fixed bottom-24 right-6 z-40 w-[280px]"
          style={{ animation: "nexus-welcome-in 480ms cubic-bezier(.2,.9,.3,1.2) both" }}
        >
          <div className="relative rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-950">
            <button
              onClick={dismissWelcome}
              aria-label="Dismiss"
              className="absolute right-2 top-2 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#0e1a3c] via-[#2b3fc8] to-[#7c3aed]">
                <NexusIcon size={24} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-bold">
                  Hi, I'm Nexus
                  <Sparkles className="h-3 w-3 text-brand-500" />
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Your AI assistant inside Tensai SecBank. Ask me anything about your
                  accounts, transfers, cards, loans, or how to use any part of the app.
                </div>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={dismissWelcome}
                className="flex-1 rounded-lg border border-slate-200 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-900"
              >
                Later
              </button>
              <button
                onClick={openFromWelcome}
                className="flex-[2] rounded-lg bg-gradient-to-r from-brand-600 to-brand-700 py-1.5 text-xs font-semibold text-white shadow-md shadow-brand-600/30 hover:brightness-110"
              >
                Say hi to Nexus
              </button>
            </div>

            {/* Tail pointing at the button */}
            <div
              aria-hidden
              className="absolute -bottom-2 right-6 h-4 w-4 rotate-45 border-b border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950"
            />
          </div>
        </div>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-24 right-6 z-40 flex h-[min(600px,80vh)] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-slate-100 bg-gradient-to-br from-brand-50 to-white px-4 py-3 dark:border-slate-800 dark:from-brand-500/10 dark:to-transparent">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#0e1a3c] via-[#2b3fc8] to-[#7c3aed]">
              <NexusIcon size={22} animated />
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="flex items-center gap-1.5 text-sm font-bold text-slate-900 dark:text-slate-100">
                Nexus
                <Sparkles className="h-3 w-3 text-brand-500" />
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">
                Your Tensai SecBank AI assistant
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages.length === 0 && (
              <div className="space-y-3">
                <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-900/50 dark:text-slate-300">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#0e1a3c] via-[#2b3fc8] to-[#7c3aed]">
                      <NexusIcon size={16} />
                    </span>
                    <div>
                      Hi {user.name?.split(" ")[0] || "there"}! I'm <b>Nexus</b>. I can walk you
                      through anything in the app — applying for a card, sending money,
                      setting up a loan, adding a payee — and also answer questions about
                      your own balance, transactions, and rewards. I'll never share your
                      MPIN, CVV, or full card number.
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
                    <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#0e1a3c] via-[#2b3fc8] to-[#7c3aed]">
                      <NexusIcon size={14} />
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
                  Nexus is thinking…
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-slate-100 dark:border-slate-800">
            {(source || messages.length > 0) && (
              <div className="flex items-center justify-between px-4 py-1.5 text-[10px] text-slate-400">
                <span>{source === "llm" ? "Nexus · AI" : source === "rules" ? "Nexus · Offline mode" : "Nexus · Ready"}</span>
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
                placeholder="Ask Nexus anything…"
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

      <style>{`
        @keyframes nexus-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }
        @keyframes nexus-pulse {
          0% { box-shadow: 0 0 0 0 rgba(124,58,237,.55); }
          70% { box-shadow: 0 0 0 18px rgba(124,58,237,0); }
          100% { box-shadow: 0 0 0 0 rgba(124,58,237,0); }
        }
        @keyframes nexus-welcome-in {
          0%   { opacity: 0; transform: translateY(12px) scale(.95); }
          100% { opacity: 1; transform: translateY(0)    scale(1); }
        }
      `}</style>
    </>
  )
}
