from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="修仙亂亂修 API")

# 記得保留原本設定好的 CORS，確保前端能正常連線
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def read_root():
    return {"message": "歡迎來到《修仙亂亂修》伺服器！"}

# 模擬角色資料，加入 max_hp 與 max_sp 上限
player_data = {
    "name": "新手冒險者",
    "base_lv": 5,
    "job_lv": 1,
    "hp": 500,
    "max_hp": 800,
    "sp": 200,
    "max_sp": 300,
    "exp": 98,
    "max_exp": 505,
    "stat_points": 19,
    "stats": {
        "str": 17,
        "agi": 11,
        "vit": 14,
        "int": 11,
        "dex": 15,
        "luk": 5
    },
    "zeny": 13900
}

@app.get("/api/player")
def get_player_data():
    return player_data

class StatUpgradeRequest(BaseModel):
    stat_name: str

@app.post("/api/upgrade_stat")
def upgrade_stat(req: StatUpgradeRequest):
    global player_data
    stat = req.stat_name
    
    if player_data["stat_points"] > 0 and stat in player_data["stats"]:
        player_data["stats"][stat] += 1
        player_data["stat_points"] -= 1
        
        # 如果點了 VIT，順便增加血量上限！
        if stat == "vit":
            player_data["max_hp"] += 50
            player_data["hp"] = min(player_data["hp"] + 50, player_data["max_hp"])
            
        return {"success": True, "message": f"成功提升 {stat.upper()}！", "data": player_data}
    else:
        return {"success": False, "message": "點數不足或素質名稱錯誤！", "data": player_data}

@app.post("/api/hunt")
def hunt_monster():
    global player_data
    
    gained_exp = 35
    gained_zeny = 150
    
    player_data["exp"] += gained_exp
    player_data["zeny"] += gained_zeny
    
    msg = f"擊敗了波利！獲得經驗值 +{gained_exp}，Zeny +{gained_zeny}。"
    
    if player_data["exp"] >= player_data["max_exp"]:
        player_data["base_lv"] += 1
        player_data["exp"] -= player_data["max_exp"]
        player_data["max_exp"] = int(player_data["max_exp"] * 1.5)
        player_data["stat_points"] += 5
        # 升級時順便恢復部分血魔與增加上限
        player_data["max_hp"] += 100
        player_data["hp"] = player_data["max_hp"]
        msg += f" 恭喜 Base Lv 提升到了 {player_data['base_lv']}！獲得 5 點素質點數！"
        
    return {"success": True, "message": msg, "data": player_data}