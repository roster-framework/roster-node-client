import type {AgentImplementation} from '@roster/runtime-node/agent';

// The agent author declares creation input. Runtime does not invent these fields.
const parameter_schema = {
  $schema:'http://json-schema.org/draft-07/schema#',
  type:'object',additionalProperties:false,
  properties:{
    project:{type:'string',minLength:1,description:'Project to review'},
    reviewDepth:{type:'string',enum:['standard','thorough'],default:'standard'},
  },
  required:['project'],
};

export function createAgents(options:{reviewer?:Record<string,unknown>}):AgentImplementation[] {
  return [{
    spec:{id:'reviewer',name:'Reviewer',description:'Parameter contract example',
      statuses:['success'],events:['complete'],skills:[],rules:[],capabilities:[]},
    parameter_schema,
    parameters:options.reviewer ?? {},
    async execute(input,context) {
      context.signal.throwIfAborted();
      context.log('Review started');
      return {status:'success',summary:'Review complete',
        output:{project:context.parameters!.project,reviewDepth:context.parameters!.reviewDepth,
          request:input.context.request,coreRule:input.context.core_instructions?.text ?? '',execution:input.execution_id},
        events:[{type:'complete',data:{}}],artifacts:[],metrics:{}};
    },
  }];
}
