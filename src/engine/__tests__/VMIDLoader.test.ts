// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { parseVMID, exportVMID } from '../VMIDLoader'
import { KinematicChain } from '../KinematicChain'
import { buildAxisMapping, describeMapping } from '../AxisMapping'

// Synthetic machines (real customer VMIDs stay out of the repo).

const V58_4X = `<?xml version="1.0" encoding="UTF-8"?>
<Machine Isvmid="1" Ver="58" ID="1" Name="Test4X" OperationType="0">
<Components>
  <Axis ID="11" Name="X" Type="0" VecX="1" VecY="0" VecZ="0" HomeRef="0" MinLim="-500" MaxLim="500"><Components>
    <Axis ID="12" Name="Y" Type="0" VecX="0" VecY="1" VecZ="0" HomeRef="0" MinLim="-400" MaxLim="400"><Components>
      <Axis ID="13" Name="Z" Type="0" VecX="0" VecY="0" VecZ="1" HomeRef="0" MinLim="-300" MaxLim="300"><Components>
        <Device ID="1" Name="Spindle" Type="2"><Gears><Gear MaxSpin="12000"/></Gears></Device>
      </Components></Axis>
    </Components></Axis>
  </Components></Axis>
  <Axis ID="4" Name="A" Type="1" VecX="-1" VecY="0" VecZ="0" CenterX="0" CenterY="10" CenterZ="-20" HomeRef="0" MinLim="0" MaxLim="3600"><Components>
    <Device ID="5" Name="Table" Type="1"/>
  </Components></Axis>
</Components>
<PostProcessors><PostProcessor Name="test_pp"/></PostProcessors>
<Combinations>
  <Combination ID="1" Name="Spindle_Table" TurretID="1" TableID="5"><AxesOrder>
    <AxisOrder AxisId="11"/><AxisOrder AxisId="12"/><AxisOrder AxisId="13"/><AxisOrder AxisId="4"/>
  </AxesOrder></Combination>
</Combinations>
</Machine>`

const V24_LATHE = `<Machine ID="0" Name="TestLathe" Ver="24" OperationType="4">
<SubDevices>
  <SubDevice ID="1" Name="Turret" Type="2" MaxSpin="6000"><Axes>
    <Axis Name="X" Id="2101" Type="0" VecX="1" VecY="0" VecZ="0" HomeRef="0" MinLim="-200" MaxLim="200"><AxisChildren>
      <Axis Name="Z" Id="2103" Type="0" VecX="0" VecY="0" VecZ="1" HomeRef="0" MinLim="-500" MaxLim="500"/>
    </AxisChildren></Axis>
  </Axes></SubDevice>
  <SubDevice ID="2" Name="Main" Type="1" MaxSpin="4000"><Axes>
    <Axis Name="C" Id="1201" Type="1" VecX="0" VecY="0" VecZ="-1" CenterX="0" CenterY="0" CenterZ="0" HomeRef="0" MinLim="-100000" MaxLim="100000"/>
  </Axes>
  <CoordSysVecX x="1" y="0" z="0"/><CoordSysVecY x="0" y="-1" z="0"/><CoordSysVecZ x="0" y="0" z="-1"/><CoordSysPlace x="0" y="0" z="100"/>
  </SubDevice>
</SubDevices>
<Combinations>
  <Combination ID="1" Name="Turret_Main" TurretID="1" TableID="2"><AxesOrder L1="2101" L2="-1" L3="2103" R1="1201" R2="-1" R3="-1"/></Combination>
</Combinations>
<Channels><Channel ID="1" Name="Ch1" NumLinearAxes="2" NumRotaryAxes="1"><SubmachinesIds Id0="1"/></Channel></Channels>
</Machine>`

describe('parseVMID — Ver 58', () => {
  const cfg = parseVMID(V58_4X)

  it('reads machine, axes and kinematic type', () => {
    expect(cfg.name).toBe('Test4X')
    expect(cfg.postprocessor).toBe('test_pp')
    expect(cfg.linearAxes).toEqual(['X', 'Y', 'Z'])
    expect(cfg.rotaryAxes).toEqual(['A'])
    expect(cfg.kinematic).toBe('Table-Table')
  })

  it('reads rotary vector, center and limits', () => {
    const a = cfg.devices.find(d => d.type === 'table')!.axes[0]
    expect(a.vector).toEqual({ x: -1, y: 0, z: 0 })
    expect(a.center).toEqual({ x: 0, y: 10, z: -20 })
    expect(a.limits).toEqual({ min: 0, max: 3600 })
  })

  it('maps the combination axis order to physical axes', () => {
    const chain = new KinematicChain(cfg)
    const m = buildAxisMapping(cfg, chain, cfg.combinations[0].id)
    expect(describeMapping(m)).toEqual({ X: 'X', Y: 'Y', Z: 'Z', A: 'A', B: null, C: null })
  })

  it('survives an export → parse round trip for axes and combinations', () => {
    const again = parseVMID(exportVMID(cfg))
    expect(again.linearAxes).toEqual(cfg.linearAxes)
    expect(again.rotaryAxes).toEqual(cfg.rotaryAxes)
    expect(again.combinations).toEqual(cfg.combinations)
  })
})

describe('parseVMID — layout detection', () => {
  it('reads a Components-layout file whose Ver is below 30 (regression: parsed as empty)', () => {
    const cfg = parseVMID(V58_4X.replace('Ver="58"', 'Ver="26"'))
    expect(cfg.axisCount).toBe(4)
    expect(cfg.combinations[0].axesOrder).toEqual({ linear: [11, 12, 13], rotary: [4] })
  })

  it('rejects a file with no recognisable axes instead of loading an empty machine', () => {
    expect(() => parseVMID('<Machine Ver="24" Name="Empty"><Foo/></Machine>')).toThrow(/no axes/)
  })
})

describe('parseVMID — Ver 24', () => {
  const cfg = parseVMID(V24_LATHE)

  it('reads sub-devices, axis tree and device coordinate system', () => {
    expect(cfg.type).toBe('turn_mill')
    expect(cfg.devices.map(d => [d.name, d.type])).toEqual([['Turret', 'spindle'], ['Main', 'table']])
    expect(cfg.devices[0].axes[0].children![0].name).toBe('Z')
    expect(cfg.devices[1].coordSys?.place).toEqual({ x: 0, y: 0, z: 100 })
  })

  it('skips -1 slots in the L/R axis order', () => {
    expect(cfg.combinations[0].axesOrder).toEqual({ linear: [2101, 2103], rotary: [1201] })
  })

  it('reads channels', () => {
    expect(cfg.channels).toEqual([{ id: 1, name: 'Ch1', submachineIds: [1], numLinearAxes: 2, numRotaryAxes: 1 }])
  })
})
