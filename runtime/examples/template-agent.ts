import type {AgentTemplate} from '../src/agent.js';

export function createAgents(){return [];}
export function createAgentTemplates():AgentTemplate[] {
 return [{id:'project-reviewer',version:'1',name:'Project reviewer',description:'Reviews one project',
  parameter_schema:{type:'object',additionalProperties:false,properties:{project:{type:'string',minLength:1},review_depth:{type:'string',enum:['standard','deep'],default:'standard'}},required:['project']},
  create:({id,name,parameters})=>({spec:{id,name,description:'Reviews one project',statuses:['ok','needs_help'],events:['complete','fail'],skills:[],rules:[],capabilities:[]},
   async execute(input,context){
    context.signal.throwIfAborted();
    context.log('Reviewing '+parameters.project);
    return {status:'ok',summary:'Review ready',output:{project:parameters.project,depth:parameters.review_depth,request:input.context.request},events:[{type:'complete',data:{}}],artifacts:[],metrics:{}};
   },
  }),
 }];
}
