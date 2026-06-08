import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Toaster } from "@/components/ui/toaster"
import { useToast } from "@/hooks/use-toast"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Badge } from "@/components/ui/badge"
import { Trash2, Play, X, Check } from "lucide-react"

function ChatMultiSelect({ selectedIds, onChange, chats }: { selectedIds: string[], onChange: (ids: string[]) => void, chats: any[] }) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState("");

  const handleSelect = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter(s => s !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  const handleCustomAdd = () => {
    if (!inputValue) return;
    
    let finalValue = inputValue;
    if (!finalValue.includes('@')) {
      const cleanNumber = finalValue.replace(/[\s\-\+()]/g, '');
      if (/^\d+$/.test(cleanNumber)) {
        finalValue = `${cleanNumber}@c.us`;
      }
    }

    if (!selectedIds.includes(finalValue)) {
      onChange([...selectedIds, finalValue]);
    }
    setInputValue("");
  };

  return (
    <div className="flex flex-col gap-2 w-full">
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-2 p-2 border rounded-md bg-secondary/20">
          {selectedIds.map(id => {
            const chat = chats.find(c => c.id === id);
            return (
              <Badge key={id} variant="secondary" className="text-sm font-normal py-1 pr-1">
                {chat ? chat.name : id}
                <button
                  className="ml-2 ring-offset-background rounded-full outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 hover:bg-destructive hover:text-destructive-foreground transition-colors p-0.5"
                  onClick={(e) => {
                    e.preventDefault();
                    handleSelect(id);
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-full justify-start text-left font-normal text-muted-foreground">
            + Add Chat
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-full sm:w-[400px] p-0" align="start">
          <Command>
            <CommandInput 
              placeholder="Search chats by name or ID..." 
              value={inputValue}
              onValueChange={setInputValue}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && inputValue) {
                  e.preventDefault();
                  handleCustomAdd();
                }
              }}
            />
            <CommandList>
              <CommandEmpty className="py-6 text-center text-sm">
                No chat found.<br/><span className="text-muted-foreground mt-2 inline-block">Press Enter to add "{inputValue}" as a custom ID.</span>
              </CommandEmpty>
              <CommandGroup heading="Discovered Chats">
                {chats.map(chat => (
                  <CommandItem
                    key={chat.id}
                    value={`${chat.name} ${chat.id}`}
                    onSelect={() => handleSelect(chat.id)}
                  >
                    <div className="flex items-center justify-between w-full">
                      <div className="flex-1 overflow-hidden overflow-ellipsis whitespace-nowrap">
                        {chat.name} <span className="text-muted-foreground text-xs font-mono ml-2">{chat.id}</span>
                      </div>
                      {selectedIds.includes(chat.id) && <Check className="ml-2 h-4 w-4 shrink-0 text-primary" />}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export default function App() {
  const [config, setConfig] = useState<any>(null);
  const [chats, setChats] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activePromptId, setActivePromptId] = useState<string>('');
  const [activeRouteIndex, setActiveRouteIndex] = useState<string>('');
  const [chatSearch, setChatSearch] = useState('');
  const [chatPage, setChatPage] = useState(1);
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testLogs, setTestLogs] = useState('');
  const [testSummary, setTestSummary] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const CHATS_PER_PAGE = 10;
  const { toast } = useToast();

  useEffect(() => {
    fetchConfig();
    fetchChats();
  }, []);

  const fetchChats = async () => {
    try {
      const response = await fetch('/bots/api/chats');
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data)) setChats(data);
      }
    } catch (error) {
      console.error('Error fetching chats:', error);
    }
  };

  const fetchConfig = async () => {
    try {
      const response = await fetch('/bots/api/config');
      if (!response.ok) throw new Error('Failed to fetch config');
      const data = await response.json();
      
      if (!Array.isArray(data.routes)) data.routes = [];

      setConfig(data);
      if (data.prompts && Object.keys(data.prompts).length > 0 && !activePromptId) {
        setActivePromptId(Object.keys(data.prompts)[0]);
      }
      if (data.routes && data.routes.length > 0 && !activeRouteIndex) {
        setActiveRouteIndex("0");
      }
      setLoading(false);
    } catch (error) {
      console.error('Error fetching config:', error);
      toast({ title: "Error", description: "Failed to load configuration.", variant: "destructive" });
      setLoading(false);
    }
  };

  const handlePromptChange = (field: string, value: any) => {
    setConfig((prev: any) => {
      const currentPrompt = prev.prompts[activePromptId];
      const newPromptObj = typeof currentPrompt === 'string' 
        ? { text: currentPrompt, model: 'gemini-3.1-flash-lite', temperature: 0.7 }
        : { ...(currentPrompt || { text: '', model: 'gemini-3.1-flash-lite', temperature: 0.7 }) };
      
      newPromptObj[field] = value;
      
      return {
        ...prev,
        prompts: {
          ...prev.prompts,
          [activePromptId]: newPromptObj
        }
      };
    });
  };

  const handlePromptIdChange = (newId: string) => {
    if (!newId || newId === activePromptId) return;
    setConfig((prev: any) => {
      const newPrompts = { ...prev.prompts };
      newPrompts[newId] = newPrompts[activePromptId];
      delete newPrompts[activePromptId];
      return { ...prev, prompts: newPrompts };
    });
    setActivePromptId(newId);
  };

  const handleRouteChange = (key: string, value: any) => {
    setConfig((prev: any) => {
      const newRoutes = [...prev.routes];
      newRoutes[parseInt(activeRouteIndex)] = {
        ...newRoutes[parseInt(activeRouteIndex)],
        [key]: value
      };
      return { ...prev, routes: newRoutes };
    });
  };

  const deletePrompt = (id: string) => {
    setConfig((prev: any) => {
      const newPrompts = { ...prev.prompts };
      delete newPrompts[id];
      return { ...prev, prompts: newPrompts };
    });
    setActivePromptId(Object.keys(config.prompts).filter(k => k !== id)[0] || '');
  };

  const deleteRoute = (index: number) => {
    setConfig((prev: any) => {
      const newRoutes = [...prev.routes];
      newRoutes.splice(index, 1);
      return { ...prev, routes: newRoutes };
    });
    setActiveRouteIndex("0");
  };

  const saveConfig = async () => {
    try {
      const response = await fetch('/bots/api/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        throw new Error('Failed to save config');
      }

      toast({ title: "Success", description: "Configuration saved successfully." });
    } catch (error) {
      console.error('Error saving config:', error);
      toast({ title: "Error", description: "Failed to save configuration.", variant: "destructive" });
    }
  };

  const handleTestRoute = async () => {
    const routeId = config?.routes?.[parseInt(activeRouteIndex)]?.id;
    if (!routeId) return;

    await saveConfig();
    
    setTestLogs('');
    setTestSummary('');
    setIsTesting(true);
    setTestModalOpen(true);
    
    try {
      const timeRange = config?.routes?.[parseInt(activeRouteIndex)]?.trigger_now || 'TODAY';
      const response = await fetch(`/bots/api/test_route_stream?route_id=${routeId}&time_range=${timeRange}`);
      if (!response.body) throw new Error("No response body");
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulatedLogs = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        accumulatedLogs += chunk;
        setTestLogs(prev => prev + chunk);
        
        const startMarker = '---SUMMARY_START---';
        const endMarker = '---SUMMARY_END---';
        const startIndex = accumulatedLogs.indexOf(startMarker);
        const endIndex = accumulatedLogs.indexOf(endMarker);
        
        if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
          const extractedSummary = accumulatedLogs.substring(startIndex + startMarker.length, endIndex).trim();
          setTestSummary(extractedSummary);
        }
      }
    } catch (e: any) {
      setTestLogs(prev => prev + '\n[Stream Error] ' + e.message);
    } finally {
      setIsTesting(false);
    }
  };

  const handleSendToWhatsapp = async () => {
    const routeId = config?.routes?.[parseInt(activeRouteIndex)]?.id;
    try {
      const res = await fetch('/bots/api/send_route_summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route_id: routeId, summary_text: testSummary })
      });
      if (res.ok) {
        toast({ title: "Success", description: "Summary sent to WhatsApp." });
        setTestModalOpen(false);
      } else {
        throw new Error("Failed to send");
      }
    } catch (e: any) {
      toast({ title: "Error", description: e.toString(), variant: "destructive" });
    }
  };

  if (loading) {
    return <div className="flex h-screen items-center justify-center dark bg-background text-foreground"><p>Loading...</p></div>;
  }

  const activePrompt = config?.prompts?.[activePromptId] || { text: '', model: 'gemini-3.1-flash-lite', temperature: 0.7 };
  const activePromptText = typeof activePrompt === 'string' ? activePrompt : (activePrompt.text || '');
  const activeModel = activePrompt.model || 'gemini-3.1-flash-lite';
  const activeTemperature = activePrompt.temperature ?? 0.7;
  const activeRoute = config?.routes?.[parseInt(activeRouteIndex)] || {};

  const filteredChats = chats.filter(c => 
    (c.name || '').toLowerCase().includes(chatSearch.toLowerCase()) || 
    (c.id || '').toLowerCase().includes(chatSearch.toLowerCase())
  );
  const totalChatPages = Math.ceil(filteredChats.length / CHATS_PER_PAGE);
  const currentChats = filteredChats.slice((chatPage - 1) * CHATS_PER_PAGE, chatPage * CHATS_PER_PAGE);

  return (
    <div className="min-h-screen dark bg-background text-foreground p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold tracking-tight">Bot Configuration</h1>
          <Button onClick={saveConfig}>Save Configuration</Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Routes Section */}
          <Card className="flex flex-col h-full">
            <CardHeader className="pb-2">
              <CardTitle>Routes</CardTitle>
              <CardDescription>Manage routing rules for parsing triggers.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 flex flex-col flex-1 pb-6">
              <div className="space-y-2">
                <Label>Select Route</Label>
                <Select value={activeRouteIndex} onValueChange={(val) => {
                  if (val === 'NEW') {
                    setConfig((prev: any) => {
                      const newRoutes = [...prev.routes, { id: `new_route_${Date.now()}`, description: '', listen_chats: [], target_chats: [], schedule_times: [], time_range: 'TODAY', prompt_id: '' }];
                      setActiveRouteIndex(String(newRoutes.length - 1));
                      return { ...prev, routes: newRoutes };
                    });
                  } else {
                    setActiveRouteIndex(val);
                  }
                }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a route" />
                  </SelectTrigger>
                  <SelectContent>
                    {config?.routes?.map((route: any, index: number) => (
                      <SelectItem key={index} value={String(index)}>{route.id || `Route ${index}`}</SelectItem>
                    ))}
                    <SelectItem value="NEW" className="text-blue-500 font-semibold">+ Create New Route</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {activeRouteIndex && activeRoute && (
                <div className="space-y-4 pt-4 border-t flex flex-col flex-1">
                  <div className="space-y-2">
                    <Label>Route ID</Label>
                    <div className="flex items-center space-x-2 flex-wrap sm:flex-nowrap gap-y-2">
                      <Input 
                        value={activeRoute.id || ''} 
                        onChange={(e) => handleRouteChange('id', e.target.value)} 
                        className="flex-1"
                      />
                      {activeRouteIndex && activeRouteIndex !== 'NEW' && activeRoute && (
                        <div className="flex items-center space-x-2 shrink-0">
                          <Select value={activeRoute.trigger_now || 'TODAY'} onValueChange={(val) => handleRouteChange('trigger_now', val)}>
                            <SelectTrigger className="w-[120px] h-9">
                              <SelectValue placeholder="Time Range" />
                            </SelectTrigger>
                            <SelectContent>
                              {['TODAY', 'YESTERDAY', 'TODAY-2', 'TODAY-3', 'TODAY-4'].map(opt => (
                                <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button variant="secondary" size="sm" className="h-9" onClick={handleTestRoute}>
                            <Play className="h-4 w-4 mr-2" />
                            Test Route
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="destructive" size="icon" className="h-9 w-9 shrink-0"><Trash2 className="h-4 w-4" /></Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will permanently delete the route '{activeRoute.id}'.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => deleteRoute(parseInt(activeRouteIndex))}>Delete</AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Description</Label>
                    <Input 
                      value={activeRoute.description || ''} 
                      onChange={(e) => handleRouteChange('description', e.target.value)} 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Listen Chats</Label>
                    <ChatMultiSelect 
                      selectedIds={activeRoute.listen_chats || []} 
                      onChange={(ids) => handleRouteChange('listen_chats', ids)} 
                      chats={chats} 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Target Chats</Label>
                    <ChatMultiSelect 
                      selectedIds={activeRoute.target_chats || []} 
                      onChange={(ids) => handleRouteChange('target_chats', ids)} 
                      chats={chats} 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Schedule Times (comma separated HH:MM)</Label>
                    <Input 
                      value={activeRoute.schedule_times ? activeRoute.schedule_times.join(', ') : ''} 
                      onChange={(e) => handleRouteChange('schedule_times', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Time Range (e.g. TODAY, YESTERDAY)</Label>
                    <Input 
                      value={activeRoute.time_range || ''} 
                      onChange={(e) => handleRouteChange('time_range', e.target.value)} 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Prompt ID</Label>
                    <Select value={activeRoute.prompt_id || ''} onValueChange={(val) => handleRouteChange('prompt_id', val)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a prompt" />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.keys(config?.prompts || {}).filter(id => id !== 'system_prompt').map(id => (
                          <SelectItem key={id} value={id}>{id}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        {/* Prompts Section */}
          <Card className="flex flex-col h-full">
            <CardHeader className="pb-2">
              <CardTitle>Prompts</CardTitle>
              <CardDescription>Manage bot prompt definitions.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 flex flex-col flex-1 pb-6">
              <div className="space-y-2">
                <Label>Select Prompt</Label>
                <Select value={activePromptId} onValueChange={(val) => {
                  if (val === 'NEW') {
                    const newId = `new_prompt_${Date.now()}`;
                    setConfig((prev: any) => ({
                      ...prev,
                      prompts: { ...prev.prompts, [newId]: { text: "New prompt text here...", model: "gemini-3.1-flash-lite", temperature: 0.7 } }
                    }));
                    setActivePromptId(newId);
                  } else {
                    setActivePromptId(val);
                  }
                }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a prompt" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(config?.prompts || {}).map(id => (
                      <SelectItem key={id} value={id}>{id}</SelectItem>
                    ))}
                    <SelectItem value="NEW" className="text-blue-500 font-semibold">+ Create New Prompt</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {activePromptId && (
                <div className="space-y-4 pt-4 border-t flex flex-col flex-1">
                  <div className="space-y-2">
                    <Label>Prompt ID</Label>
                    <div className="flex items-center space-x-2">
                      <Input 
                        value={activePromptId} 
                        onChange={(e) => handlePromptIdChange(e.target.value)} 
                        disabled={activePromptId === 'system_prompt'}
                      />
                      {activePromptId && activePromptId !== 'NEW' && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="destructive" size="icon" className="h-9 w-9 shrink-0" disabled={activePromptId === 'system_prompt'}><Trash2 className="h-4 w-4" /></Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will permanently delete the prompt '{activePromptId}'.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => deletePrompt(activePromptId)}>Delete</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </div>
                  <div className="flex space-x-4">
                    <div className="space-y-2 flex-1">
                      <Label>Model Name</Label>
                      <Input 
                        value={activeModel} 
                        onChange={(e) => handlePromptChange('model', e.target.value)} 
                      />
                    </div>
                    <div className="space-y-2 flex-1">
                      <Label>Temperature</Label>
                      <Input 
                        type="number" 
                        step="0.1" 
                        min="0" 
                        max="2"
                        value={activeTemperature} 
                        onChange={(e) => handlePromptChange('temperature', parseFloat(e.target.value))} 
                      />
                    </div>
                  </div>
                  <div className="space-y-2 flex flex-col flex-1 pb-2">
                    <Label>Prompt Template</Label>
                    <Textarea 
                      className="flex-1 min-h-[500px] resize-none"
                      value={activePromptText} 
                      onChange={(e) => handlePromptChange('text', e.target.value)} 
                    />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          </div>

        {/* Chats Dictionary Table */}
        <div className="mt-8">
          <Card>
            <CardHeader className="pb-2 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <CardTitle>Chat Dictionary</CardTitle>
                <CardDescription>Self-updating list of discovered WhatsApp chats.</CardDescription>
              </div>
              <Input 
                placeholder="Search by name or ID..." 
                value={chatSearch}
                onChange={(e) => {
                  setChatSearch(e.target.value);
                  setChatPage(1);
                }}
                className="max-w-xs"
              />
            </CardHeader>
            <CardContent>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Owner</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>ID</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentChats.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center h-24 text-muted-foreground">
                          {chats.length === 0 ? "No chats discovered yet. Ensure the bot is connected and receiving messages." : "No chats matched your search."}
                        </TableCell>
                      </TableRow>
                    ) : (
                      currentChats.map((chat) => (
                        <TableRow key={chat.id}>
                          <TableCell>{chat.owner}</TableCell>
                          <TableCell>{chat.type}</TableCell>
                          <TableCell>{chat.name}</TableCell>
                          <TableCell className="font-mono text-xs">{chat.id}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center justify-between mt-4">
                <div className="text-sm text-muted-foreground">
                  Showing {Math.min((chatPage - 1) * CHATS_PER_PAGE + 1, filteredChats.length)} to {Math.min(chatPage * CHATS_PER_PAGE, filteredChats.length)} of {filteredChats.length} chats
                </div>
                <div className="flex space-x-2">
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => setChatPage(p => Math.max(1, p - 1))}
                    disabled={chatPage === 1}
                  >
                    Previous
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => setChatPage(p => Math.min(totalChatPages, p + 1))}
                    disabled={chatPage === totalChatPages || totalChatPages === 0}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

      </div>

      {testModalOpen && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8">
          <div className="bg-card text-card-foreground border rounded-lg shadow-lg w-full max-w-5xl h-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="p-4 border-b flex justify-between items-center bg-muted/50">
              <h2 className="text-xl font-bold">Testing Route: {activeRoute.id}</h2>
              <Button variant="ghost" size="icon" onClick={() => setTestModalOpen(false)}><X className="h-5 w-5" /></Button>
            </div>
            
            <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
              <div className="flex-1 border-r p-4 overflow-y-auto font-mono text-sm bg-secondary/10 whitespace-pre-wrap">
                <div className="font-bold mb-2">Execution Logs:</div>
                {testLogs || 'Starting...'}
              </div>
              
              <div className="flex-1 p-4 overflow-y-auto flex flex-col bg-background">
                <div className="font-bold mb-2">Generated Summary:</div>
                {testSummary ? (
                  <Textarea 
                    className="flex-1 resize-none"
                    value={testSummary}
                    onChange={(e) => setTestSummary(e.target.value)}
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground border-2 border-dashed rounded-md">
                    {isTesting ? "Waiting for summary..." : "No summary generated."}
                  </div>
                )}
              </div>
            </div>
            
            <div className="p-4 border-t bg-muted/50 flex justify-end space-x-4">
              <Button variant="outline" onClick={() => setTestModalOpen(false)}>Cancel</Button>
              <Button 
                onClick={handleSendToWhatsapp} 
                disabled={isTesting || !testSummary}
              >
                Send to WhatsApp
              </Button>
            </div>
          </div>
        </div>
      )}

      <Toaster />
    </div>
  )
}
