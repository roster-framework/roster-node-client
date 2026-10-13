import json, sys, time, os
def send(value):
    print(json.dumps(value), flush=True)
request=json.loads(sys.stdin.readline())
if request['type']=='validate':
    send({'type':'ready'});sys.exit()
mode=request['request'].get('mode')
if mode in ('usage', 'invalid-usage'):
    usage={'version':1,'invocation_id':'python-call','provider':'fixture','model':'small','phase':'loop','state':'completed','input_tokens':12,'output_tokens':0,'cached_input_tokens':7,'prompt':'private-fixture'}
    if mode=='invalid-usage':usage['input_tokens']=-1
    send({'type':'model-usage','value':usage})
    send({'type':'model-usage','value':usage})
    send({'type':'result','value':{'status':'ok','summary':'Usage complete','output':'Done','event':'complete'}})
    sys.exit()
if mode=='credential':
    assert os.environ.get('REVIEWER_API_KEY') == 'vault-reviewer-fixture'
    assert 'OTHER_API_KEY' not in os.environ
    send({'type':'result','value':{'status':'ok','summary':'Credential isolated','output':'Checked','event':'complete'}})
    sys.exit()
if mode=='wait':
    time.sleep(60);sys.exit()
if mode=='invalid':
    print('invalid',flush=True);sys.exit()
if mode=='oversized':
    print('x'*1000001,flush=True);sys.exit()
call={'type':'tool','id':'call-1','name':'unknown' if mode=='unknown' else 'safe','args':{'text':'hello'}}
send(call)
response=sys.stdin.readline()
if not response:sys.exit(1)
if mode=='duplicate':
    send(call);sys.stdin.readline();sys.exit()
send({'type':'log','text':'Published note'})
send({'type':'result','value':{'status':'ok','summary':'Done','output':'Done','event':'complete'}})
