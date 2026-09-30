# Receipt Task — Mission Pipeline 3

PM records the agreed result, scope and route after aligning with the user. Replace
placeholders with current ids, actual input blobs and agreed criteria. For a task
revision, add its current stored digest as `revises`. `seal` supplies this document's
`source_blob` and request id. Define all required verification before plan review.

Use `execution` when design and criteria are decided. Use `exploration` when the
subtask produces findings for a decision; state its question and stopping conditions
in the criteria and source. Split mixed work into children. Future undecided scope
uses `milestone` with no writes, outputs, workers or verification.

## Agreed outcome and original authority

State the user's requirement, the PM decision and the observable delivery expected.

## Prerequisites and unlocks

Name accepted producer tasks, required interface versions and downstream work this
delivery will unlock. A required input interface belongs in `prerequisites`; an
interface assigned for construction belongs in `outputs`.

## Work and verification

Describe the worker scope and required checks. Parallel workers have disjoint paths.
Shared integration uses a dependent task with its own output and seam checks.

```mp-json
{
  "action": "task.record",
  "data": {
    "id": "subtask-id",
    "mission": "mission-id",
    "obligations": ["obligation-id"],
    "grant": "grant-id",
    "domain": "method",
    "effects": ["required-effect"],
    "allowed_effects": ["required-effect"],
    "inputs": ["input-CAS"],
    "work_type": "execution",
    "priority": 10,
    "criteria": {"obligation-id": "Agreed observable result"},
    "write_paths": ["src/product.py"],
    "outputs": ["result/report.txt"],
    "workers": [{
      "id": "build",
      "write_paths": ["src/product.py"],
      "outputs": ["result/report.txt"]
    }],
    "prerequisites": [],
    "dependencies": [],
    "decision_dependencies": [],
    "specialist_review": false,
    "wave": 1
  }
}
```
