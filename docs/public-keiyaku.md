# Invocation Facet

`Keiyaku` composes independent product surfaces for a caller that has an
invocation directory and environment rather than resolved product coordinates.
It captures those explicit inputs without observing the filesystem or reading
ambient process state. Each operation resolves its invocation scope anew; the
facet keeps no persistent authority, observation cache, or separate result model.
Its operations return native owner values and preserve owner refusal, retry,
cancellation, and observation semantics.

The invocation World is distinct from an explicitly selected Contract Repo:
selecting a Repo never retargets the World. The facet adapts caller-supplied
coordinates, Contract selection, and environment-derived actor, caller, and
initiator attribution. These declarations are not authentication. Akuma
execution directories remain independent of Contract association. Product
surfaces neither depend on the facet nor require it to operate.

Mixed reads select the appropriate existing owner without inventing a catalogue
or merging independent authorities. A plural status may contain different
selector families and retains their order; a Contract wait and an Akuma wait
remain separate and a mixed wait is refused before observation. History selects
one subject. A caller-input error is distinguishable from an owner refusal or
an unexpected failure, and adds no authority to the facet.
