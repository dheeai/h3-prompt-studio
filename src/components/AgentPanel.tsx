import { useEffect, useMemo, useRef, useState } from 'react'
import { Agent } from '@mariozechner/pi-agent-core'
import type { AgentEvent } from '@mariozechner/pi-agent-core'
import { streamSimpleOpenAICompletions } from '@mariozechner/pi-ai/openai-completions'
import type { Model } from '@mariozechner/pi-ai'
import { useApp } from '../app/state'
import { agentApiKey, agentEventStatus, buildAgentModel, buildAgentTools, reduceAgentEvent, type AgentConfirmation, type AgentTranscriptItem } from '../lib/agent'
import { buildH3SystemPrompt } from '../lib/context'
import { isCanonicalPromptStage } from '../lib/studio-workflow'
import { ProseDoc } from './ProseDoc'

interface AgentPanelProps {
  onOpenStudio: () => void
}

export function AgentPanel({ onOpenStudio }: AgentPanelProps) {
  const app = useApp()
  const provider = app.providers.find((candidate) => candidate.id === app.settings.providerId)
  const [items, setItems] = useState<AgentTranscriptItem[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [pending, setPending] = useState<AgentConfirmation | null>(null)
  const [status, setStatus] = useState('Ready to work on the shared Studio state.')
  const agentRef = useRef<Agent | null>(null)

  // AppProvider intentionally exposes a fresh API object when shared Studio
  // state changes. Keep the Agent instance keyed only to the selected model;
  // the refs below let its stream/tools see fresh state without aborting an
  // active run every time a token or prompt version is committed.
  const providerRef = useRef(provider)
  providerRef.current = provider
  const settingsRef = useRef(app.settings)
  settingsRef.current = app.settings
  const model = useMemo(() => provider && app.settings.model ? buildAgentModel(provider, app.settings.model) : null, [provider?.id, provider?.baseUrl, app.settings.model])
  const tools = buildAgentTools(app, setPending)

  useEffect(() => {
    if (!provider || !model) {
      agentRef.current?.abort()
      agentRef.current = null
      return
    }
    const agent = new Agent({
      initialState: {
        systemPrompt: buildH3SystemPrompt(app.context, 'agent'),
        model,
        thinkingLevel: 'off',
        tools,
        messages: [],
      },
      toolExecution: 'sequential',
      streamFn: (streamModel, context, options) => streamSimpleOpenAICompletions(streamModel as Model<'openai-completions'>, context, {
        ...options,
        apiKey: providerRef.current ? agentApiKey(providerRef.current) : undefined,
        temperature: settingsRef.current.temperature,
        ...(settingsRef.current.maxTokens > 0 ? { maxTokens: settingsRef.current.maxTokens } : {}),
      }),
    })
    let turns = 0
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === 'agent_start') turns = 0
      if (event.type === 'turn_start') {
        turns += 1
        // A tool-capable model can get stuck repeating a read or mutation. A
        // bounded guard makes the browser agent fail visibly instead of
        // creating the continuous loop the Studio deliberately avoids.
        if (turns > 4) agent.abort()
      }
      setItems((previous) => reduceAgentEvent(previous, event))
      if (event.type === 'tool_execution_end') {
        const details = event.result?.details && typeof event.result.details === 'object' ? event.result.details as Record<string, unknown> : undefined
        if (details?.requiresConfirmation === 'render_current' || details?.requiresConfirmation === 'render_multiclip') setPending(details.requiresConfirmation)
      }
      const outcome = agentEventStatus(event)
      if (outcome) {
        setRunning(false)
        setStatus(outcome.message)
      }
    })
    agentRef.current = agent
    return () => {
      unsubscribe()
      agent.abort()
      if (agentRef.current === agent) agentRef.current = null
    }
  }, [provider?.id, provider?.baseUrl, app.settings.model])

  // Refresh the Agent's contract and deterministic tools in place. This
  // effect deliberately does not own Agent construction, so a context update
  // while the model is streaming cannot silently tear down that run.
  useEffect(() => {
    const agent = agentRef.current
    if (!agent || !model) return
    agent.state.systemPrompt = buildH3SystemPrompt(app.context, 'agent')
    agent.state.model = model
    agent.state.tools = tools
  }, [app.context?.hash, model, tools])

  const send = async (text = input) => {
    const prompt = text.trim()
    const agent = agentRef.current
    if (!prompt || !agent || running) return
    const id = `user-${Date.now().toString(36)}`
    setItems((previous) => [...previous, { id, kind: 'user', text: prompt }])
    setInput('')
    setRunning(true)
    setStatus('Thinking…')
    try {
      await agent.prompt(prompt)
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        const message = String((error as Error).message || error)
        setItems((previous) => previous.some((item) => item.kind === 'assistant' && item.status === 'error' && item.text.includes(message))
          ? previous
          : [...previous, { id: `error-${Date.now().toString(36)}`, kind: 'assistant', status: 'error', text: message }])
        setStatus(`The agent stopped with an error: ${message}`)
      }
      setRunning(false)
    }
  }

  const stop = () => {
    agentRef.current?.abort()
    setRunning(false)
    setStatus('Stopped. Partial thinking remains in this transcript.')
  }

  const confirm = async () => {
    if (!pending) return
    const action = pending
    setPending(null)
    setStatus(action === 'render_current' ? 'Submitting the canonical prompt to ComfyUI…' : 'Submitting the clip plan to ComfyUI…')
    if (action === 'render_current') await app.render()
    else await app.renderMulticlip()
    setStatus('Submission requested. Follow progress in Studio.')
  }

  return (
    <main className="agent-workspace" aria-label="Agent beta workspace">
      <section className="agent-main">
        <div className="agent-head">
          <div><div className="studio-kicker">AGENT · BETA</div><h1>Direct the Studio</h1><p>Same model, same skills, same canonical prompt.</p></div>
          <div className="agent-head-state"><span className={`studio-health-dot ${provider && app.settings.model ? 'ok' : 'idle'}`} />{provider && app.settings.model ? `${app.settings.model} ready` : 'Connect a model'}</div>
        </div>
        <div className="agent-transcript" aria-live="polite">
          {!items.length && <div className="agent-empty"><div className="studio-kicker">START WITH AN INTENT</div><h2>What should we make next?</h2><p>The Agent can inspect and update the Studio, but every prompt mutation is recorded in the same history.</p><div className="agent-starters"><button onClick={() => void send('Turn this idea into a canonical H3 prompt.')}>Turn this idea into a prompt</button><button onClick={() => void send('Break the current story into a connected clip plan.')}>Break this story into clips</button><button onClick={() => void send('Continue from the selected rendered clip.')}>Continue from the selected clip</button><button onClick={() => void send('Improve the current canonical prompt using the loaded skills.')}>Improve the current prompt</button></div></div>}
          {items.map((item) => item.kind === 'tool' ? (
            <article className={`agent-tool-card ${item.status === 'error' ? 'error' : ''}`} key={item.id}><div className="agent-item-meta"><span className="studio-kicker">TOOL</span><strong>{item.toolName}</strong><span className="tok">{item.status === 'running' ? 'running…' : item.status}</span></div><pre>{item.text}</pre>{typeof item.details?.versionId === 'string' && <div className="agent-tool-result">✓ {item.details.versionId} is now canonical</div>}{typeof item.details?.requiresConfirmation === 'string' && <div className="agent-confirm-inline"><span>This operation is ready but needs your confirmation.</span><button className="btn pri sm" onClick={() => void confirm()}>Confirm in Agent</button></div>}<button className="btn ghost sm" onClick={onOpenStudio}>Open in Studio →</button></article>
          ) : item.kind === 'thinking' ? (
            <article className="agent-thinking" key={item.id}><div className="agent-item-meta"><span className="studio-kicker">THINKING</span><span className="tok">retained working notes</span></div><div>{item.text}</div></article>
          ) : (
            <article className={`agent-message ${item.kind}`} key={item.id}><div className="agent-item-meta"><span className="studio-kicker">{item.kind === 'user' ? 'YOU' : 'AGENT'}</span></div>{item.kind === 'assistant' ? <ProseDoc text={item.text} /> : <div>{item.text}</div>}</article>
          ))}
          {running && <div className="agent-running"><span className="spin" />{status}</div>}
        </div>
        <div className="agent-compose"><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} placeholder={provider && app.settings.model ? 'Ask the Agent to inspect, improve, or prepare…' : 'Connect a model to start the Agent'} disabled={!provider || !app.settings.model || running} rows={3} aria-label="Agent instruction" /><div className="agent-compose-row"><span>{status}</span>{running ? <button className="btn" onClick={stop}>Stop</button> : <button className="btn pri" onClick={() => void send()} disabled={!input.trim() || !provider || !app.settings.model}>Send to Agent</button>}</div></div>
      </section>
      <aside className="agent-context"><div className="studio-kicker">SHARED CONTEXT</div><h2>Studio stays the source of truth</h2><div className="agent-context-card"><span>Canonical prompt</span><strong>{app.current && isCanonicalPromptStage(app.current.stage) ? `v${app.versions.findIndex((version) => version.id === app.current?.id) + 1}` : 'not written yet'}</strong></div><div className="agent-context-card"><span>Clip plan</span><strong>{app.breakdown ? `${app.breakdown.clips.length} clips` : 'not set'}</strong></div><div className="agent-context-card"><span>Skills</span><strong>{app.skills.filter((skill) => app.settings.selection[skill.id]?.length).length} loaded</strong></div><div className="agent-context-card"><span>ComfyUI</span><strong>{app.endpoint?.label || 'configure in Studio'}</strong></div><div className="agent-context-note">Render and multiclip submission always pause for confirmation. The Agent never calls Studio stages recursively.</div><button className="btn" onClick={onOpenStudio}>Open full Studio</button></aside>
    </main>
  )
}
