import { describe, expect, it } from 'vitest'
import { searchTools, tokenize, type SearchableTool } from '../src/tools/search.js'

const tool = (name: string, description = '', properties: Record<string, unknown> = {}): SearchableTool => ({
  name,
  description,
  input_schema: { type: 'object', properties },
})

describe('tool search: BM25 (SPEC §6.8)', () => {
  it('tokens are lower-cased letter / digit runs of two or more characters, any script', () => {
    expect(tokenize('Refund an order, №5 — возврат заказа!')).toEqual(['refund', 'an', 'order', 'возврат', 'заказа'])
  })

  it('the name is split on camelCase, _ and -', () => {
    const tools = [tool('createReturn'), tool('export_report'), tool('send-invoice'), tool('getHTTPStatus')]
    expect(searchTools(tools, 'return')).toEqual(['createReturn'])
    expect(searchTools(tools, 'report')).toEqual(['export_report'])
    expect(searchTools(tools, 'invoice')).toEqual(['send-invoice'])
    expect(searchTools(tools, 'status')).toEqual(['getHTTPStatus'])
  })

  it('argument names and their descriptions are searched, nested ones too', () => {
    const tools = [
      tool('a', 'first', { trackingNumber: { type: 'string' } }),
      tool('b', 'second', { filter: { type: 'object', properties: { warehouse: { type: 'string', description: 'Depot code' } } } }),
    ]
    expect(searchTools(tools, 'tracking number')).toEqual(['a'])
    expect(searchTools(tools, 'warehouse')).toEqual(['b'])
    expect(searchTools(tools, 'depot')).toEqual(['b'])
  })

  it('only positive scores, best first, ties by name, at most limit', () => {
    const tools = [
      tool('zeta', 'refund an order'),
      tool('alpha', 'refund an order'),
      tool('refundOrder', 'refund an order refund'),
      tool('other', 'shipping rates'),
    ]
    expect(searchTools(tools, 'refund')).toEqual(['refundOrder', 'alpha', 'zeta'])
    expect(searchTools(tools, 'refund', 2)).toEqual(['refundOrder', 'alpha'])
    expect(searchTools(tools, 'nothing here')).toEqual([])
  })

  it('the limit is clamped to 1..20', () => {
    const tools = Array.from({ length: 25 }, (_, i) => tool(`tool${String(i).padStart(2, '0')}`, 'export data'))
    expect(searchTools(tools, 'export', 100)).toHaveLength(20)
    expect(searchTools(tools, 'export', 0)).toHaveLength(1)
  })

  it('the query is cut to 500 characters', () => {
    const tools = [tool('needle', 'needle')]
    expect(searchTools(tools, `${'x'.repeat(500)} needle`)).toEqual([])
    expect(searchTools(tools, `${'x '.repeat(240)}needle`)).toEqual(['needle'])
  })
})
